import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";
import {Character, User} from "@chub-ai/stages-ts";
import {Parser} from "expr-eval";
import {Variable, VariableDefinition} from "./Variable";
import * as yaml from 'js-yaml';
import {Client} from "@gradio/client";
import {PromptRule} from "./PromptRule";

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

    async processVariables(content: string, contentSource: string, botId: string) {
        for (const entry of Object.values(this.variableDefinitions)) {
            console.log('Variable:' + entry);
            // Generate variable if not present.
            if (!this.variables[entry.name]) {
                console.log('Initialize variable');
                this.variables[entry.name] = new Variable(entry.name, this.variableDefinitions);
            }

            let variable = this.variables[entry.name];
            let hypothesisTemplate = this.replaceTags((contentSource == 'input' ? entry.inputHypothesis : entry.responseHypothesis) ?? '', {"user": this.user.name, "char": this.characters[botId]?.name ?? ''});
            if (hypothesisTemplate.trim() != '') {
                console.log('process');
                let updateFormula = entry.defaultUpdate;
                if (entry.classificationMap && Object.keys(entry.classificationMap).length > 0) {
                    let response = await this.query({sequence: content, candidate_labels: Object.keys(entry.classificationMap), hypothesis_template: hypothesisTemplate, multi_label: true});

                    updateFormula = response && response.scores[0] >= entry.classificationThreshold ? entry.classificationMap[response.labels[0]] : updateFormula;
                }
                console.log('post pipeline');

                console.log(`Before: ${variable.value}`);
                variable.value = Parser.evaluate(this.replaceTags(updateFormula, {}));
                console.log(`After: ${variable.value}`);
            }
        }
    }

    replaceTags(source: string, replacements: {[name: string]: string}) {
        for (const key of Object.keys(this.variables)) {
            replacements[key] = this.variables[key].value;
        }

        return source.replace(/{{([A-z]*)}}/g, (match) => {
            return replacements[match.substring(2, match.length - 2)];
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
        await this.processVariables(content, 'input', promptForId ?? '');

        let stageDirections = '' + Object.values(this.promptRules).map(promptRule => promptRule.evaluate(this)).filter(prompt => prompt.trim().length > 0).join('/n');

        console.log('finished beforePrompt');
        return {
            stageDirections: stageDirections != '' ? `[INST]/n${stageDirections}/n[/INST]` : null,
            messageState: this.writeMessageState(),
            modifiedMessage: null,
            systemMessage: null,
            error: null,
            chatState: null,
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {

        const {
            content,
            anonymizedId
        } = botMessage;
        console.log('start afterResponse');
        await this.processVariables(content, 'response', anonymizedId);
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
