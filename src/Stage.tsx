import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";
import {Character, User} from "@chub-ai/stages-ts";
import {Parser} from "expr-eval";
import {Variable, VariableDefinition} from "./Variable";
import * as yaml from 'js-yaml';
import {Client} from "@gradio/client";
import {PromptRule} from "./PromptRule";
import {Classification, Classifier} from "./Classifier";

type MessageStateType = any;
type ConfigType = any;
type InitStateType = any;
type ChatStateType = any;

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {

    // message-level variables:
    variables: {[key: string]: any}
    // other:
    config: any;
    variableDefinitions: {[key: string]: VariableDefinition};
    promptRules: PromptRule[];
    classifiers: Classifier[];
    characters: {[key: string]: Character};
    user: User;
    displayMessage: string = '';
    client: any;
    fallbackPipeline: any;

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);
        const {
            characters,
            users,
            config,
            messageState
        } = data;
        this.characters = characters;
        this.user = users[Object.keys(users)[0]];
        this.variables = {};
        this.variableDefinitions = {};
        this.promptRules = [];
        this.classifiers = [];
        this.config = config;

        this.readMessageState(messageState);
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {

        let yamlResponse = await fetch('chub_meta.yaml');
        const data: any = yaml.load(await yamlResponse.text());

        const variableDefinitions: VariableDefinition[] = JSON.parse(this.config.variableConfig ?? data.config_schema.properties.variableConfig.value);
        for (const definition of variableDefinitions) {
            this.variableDefinitions[definition.name] = new VariableDefinition(definition);
        }
        Object.values(JSON.parse(this.config.promptConfig ?? data.config_schema.properties.promptConfig.value)).forEach(promptRule => this.promptRules.push(new PromptRule(promptRule)));
        Object.values(JSON.parse(this.config.classifierConfig ?? data.config_schema.properties.classifierConfig.value)).forEach(classifier => this.classifiers.push(new Classifier(classifier)));

        this.displayMessage = this.config.displayMessage ?? data.config_schema.properties.displayMessage.value ?? '';

        this.client = await Client.connect("JHuhman/statosphere-backend", {hf_token: import.meta.env.VITE_HF_API_KEY});

        console.log('Finished loading.');
        return {
            success: true,
            error: null,
            initState: null,
            chatState: null,
        };
    }

    async setState(state: MessageStateType): Promise<void> {
        this.readMessageState(state);
    }

    readMessageState(messageState: MessageStateType) {
        if (messageState != null) {
            this.variables = messageState.variables ?? {};
        }
    }

    writeMessageState(): MessageStateType {
        return {
            variables: this.variables
        }
    }

    initializeVariable(name: string) {
        console.log('Initialize variable');
        this.variables[name] = new Variable(name, this.variableDefinitions);
    }
    async updateVariable(name: string, update: string) {
        // If variable is not present, initialize, otherwise, update.
        if (!this.variables[name]) {
            this.initializeVariable(name);
        } else {
            this.variables[name].value = Parser.evaluate(this.replaceTags(update, {}));
        }
    }

    async processVariables() {
        for (const entry of Object.values(this.variableDefinitions)) {
            if (entry.perTurnUpdate) {
                await this.updateVariable(entry.name, entry.perTurnUpdate);
            } else if (!this.variables[entry.name]) {
                this.initializeVariable(entry.name);
            }
        }
    }

    async processClassifiers(content: string, contentSource: string, botId: string) {
        for (const classifier of Object.values(this.classifiers)) {

            let hypothesisTemplate = this.replaceTags((contentSource == 'input' ? classifier.inputHypothesis : classifier.responseHypothesis) ?? '', {"user": this.user.name, "char": this.characters[botId]?.name ?? ''});
            if (hypothesisTemplate.trim() != '') {
                console.log('process classifier');

                let response = await this.query({sequence: content, candidate_labels: Object.keys(classifier.classifications), hypothesis_template: hypothesisTemplate, multi_label: true});

                let selectedClassifications: {[key: string]: Classification} = {};
                let categoryScores: {[key: string]: number} = {};
                console.log(`Labels size:${response.labels.size}. Length:${response.labels.length}`);
                for (let i = 0; i < response.labels.length; i++) {
                    let classification = classifier.classifications[response.labels[i]];
                    console.log(`Looking at ${response.labels[i]}:${response.scores[i]}. Compare to ${classification.threshold} or ${categoryScores[classification.category] ?? 0}`);
                    if (response.scores[i] >= Math.max(classification.threshold, categoryScores[classification.category] ?? 0)) {
                        console.log(`Adding ${classification.label}`);
                        selectedClassifications[classification.category] = classification;
                        categoryScores[classification.category] = response.scores[i];
                    }
                }

                // Go through all operations and execute them.
                for (let classification of Object.values(selectedClassifications)) {
                    console.log(`Considering ${classification.label}`)
                    for (let variable of Object.keys(classification.updates)) {
                        let oldValue = this.variables[variable].value;
                        await this.updateVariable(variable, classification.updates[variable]);
                        console.log(`Updated ${variable} from ${oldValue} to ${this.variables[variable].value}`);
                    }
                }
            }
        }
    }

    replaceTags(source: string, replacements: {[name: string]: string}) {
        for (const key of Object.keys(this.variables)) {
            replacements[key.toLowerCase()] = this.variables[key].value;
        }

        return source.replace(/{{([A-z]*)}}/g, (match) => {
            return replacements[match.substring(2, match.length - 2).toLowerCase()];
        });
    }

    async query(data: any) {
        console.log(data);
        let result: any = null;
        if (this.client) {
            try {
                const response = await this.client.predict("/predict", {data_string: JSON.stringify(data)});
                console.log(response.data[0]);
                result = JSON.parse(`${response.data[0]}`);
            } catch(e) {
                console.log(e);
            }
        }
        if (!result) {
            console.log('Falling back to local pipeline.');
            result = await this.fallbackPipeline(data.sequence, data.candidate_labels, { hypothesis_template: data.hypothesis_template, multi_label: data.multi_label });
        }

        return result;
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {

        const {
            content,
            promptForId
        } = userMessage;
        console.log('start beforePrompt');
        await this.processVariables();
        await this.processClassifiers(content, 'input', promptForId ?? '');

        let stageDirections = this.replaceTags('' + Object.values(this.promptRules).map(promptRule => promptRule.evaluate(this)).filter(prompt => prompt.trim().length > 0).join('\n'), {'user': this.user.name, 'char': (this.characters[promptForId ?? ''] ? this.characters[promptForId ?? ''].name : '')});

        console.log('finished beforePrompt');
        return {
            stageDirections: stageDirections != '' ? `[INST]\n${stageDirections}\n[/INST]` : null,
            messageState: this.writeMessageState(),
            modifiedMessage: null,
            systemMessage: null,
            error: null,
            chatState: null
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {

        const {
            content,
            anonymizedId
        } = botMessage;
        console.log('start afterResponse');
        await this.processClassifiers(content, 'response', anonymizedId);
        console.log(`finished afterResponse`);
        return {
            stageDirections: null,
            messageState: this.writeMessageState(),
            modifiedMessage: null,
            error: null,
            systemMessage: (this.displayMessage && this.displayMessage.trim() != '') ?
                this.replaceTags(this.displayMessage, {'user': this.user.name, 'char': (this.characters[anonymizedId] ? this.characters[anonymizedId].name : '')}) : null,
            chatState: null
        };
    }


    render(): ReactElement {

        return <div style={{
            width: '100vw',
            height: '100vh',
            display: 'grid',
            alignItems: 'stretch'
        }}>
        </div>;
    }

}
