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

    readonly DEFAULT_THRESHOLD = 0.8;

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
    debugMode: boolean;

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
        this.debugMode = false;

        this.readMessageState(messageState);
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {

        let yamlResponse = await fetch('chub_meta.yaml');
        const data: any = yaml.load(await yamlResponse.text());

        const variableDefinitions: VariableDefinition[] = JSON.parse(this.config.variableConfig ?? data.config_schema.properties.variableConfig.value);
        for (const definition of variableDefinitions) {
            this.variableDefinitions[definition.name] = new VariableDefinition(definition);
            this.initializeVariable(definition.name);
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

    getVariable(name: string): any {
        if (this.variableDefinitions[name]) {
            if (!this.variables[name]) {
                this.initializeVariable(name);
            }
            return this.variables[name].value;
        }
        return '';
    }

    setVariable(name: string, value: any) {
        if (this.variableDefinitions[name]) {
            if (!this.variables[name]) {
                this.initializeVariable(name);
            }
            this.variables[name].value = value;
        }
    }
    updateVariable(name: string, formula: string) {
        this.setVariable(name, Parser.evaluate(this.replaceTags(formula, {})))
    }

    initializeVariable(name: string) {
        this.variables[name] = new Variable(name, this.variableDefinitions);
    }

    async processVariables() {
        for (const entry of Object.values(this.variableDefinitions)) {
            if (entry.perTurnUpdate) {
                this.updateVariable(entry.name, entry.perTurnUpdate);
            }
        }
    }

    async processClassifiers(content: string, contentSource: string, botId: string) {
        for (const classifier of Object.values(this.classifiers)) {
            const replacementMapping: any = {"user": this.user.name, "char": this.characters[botId]?.name ?? ''};

            let sequenceTemplate = this.replaceTags((contentSource == 'input' ? classifier.inputTemplate : classifier.responseTemplate) ?? '', replacementMapping);
            sequenceTemplate = sequenceTemplate.trim() == '' ? content : sequenceTemplate.replace('{}', content);
            let hypothesisTemplate = this.replaceTags((contentSource == 'input' ? classifier.inputHypothesis : classifier.responseHypothesis) ?? '', replacementMapping);
            if (hypothesisTemplate.trim() != '') {
                let candidateLabels = [];
                let labelMapping: { [key: string]: string } = {};
                for (let label in Object.keys(classifier.classifications)) {
                    let subbedLabel = this.replaceTags(label, replacementMapping);
                    candidateLabels.push(subbedLabel);
                    labelMapping[subbedLabel] = label;
                }

                let response = await this.query({sequence: sequenceTemplate, candidate_labels: candidateLabels, hypothesis_template: hypothesisTemplate, multi_label: true});

                let selectedClassifications: {[key: string]: Classification} = {};
                let categoryScores: {[key: string]: number} = {};
                for (let i = 0; i < response.labels.length; i++) {
                    let classification = classifier.classifications[labelMapping[response.labels[i]]];
                    if (response.scores[i] >= Math.max(classification.threshold ?? this.DEFAULT_THRESHOLD, categoryScores[classification.category] ?? 0)) {
                        selectedClassifications[classification.category] = classification;
                        categoryScores[classification.category] = response.scores[i];
                    }
                }

                // Go through all operations and execute them.
                for (let classification of Object.values(selectedClassifications)) {
                    for (let variable of Object.keys(classification.updates)) {
                        let oldValue = this.getVariable(variable);
                        this.updateVariable(variable, classification.updates[variable]);
                        console.log(`Updated ${variable} from ${oldValue} to ${this.getVariable(variable)}`);
                    }
                }
            }
        }
    }

    replaceTags(source: string, replacements: {[name: string]: string}) {
        for (const key of Object.keys(this.variables)) {
            replacements[key.toLowerCase()] = this.getVariable(key);
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
