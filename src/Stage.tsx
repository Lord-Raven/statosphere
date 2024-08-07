import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";
import {Character, User} from "@chub-ai/stages-ts";
import {Parser} from "expr-eval";
import {Variable, VariableDefinition} from "./Variable";
import {env, pipeline} from '@xenova/transformers';
import * as yaml from 'js-yaml';

type MessageStateType = any;
type ConfigType = any;
type InitStateType = any;
type ChatStateType = any;

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {

    // message-level variables:
    variables: {[key: string]: any}
    // other:
    config: any;
    variableDefinitions: {[key: string]: VariableDefinition}
    classificationPipeline: any;
    characters: {[key: string]: Character};
    user: User;
    parser: Parser = new Parser();

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);
        const {
            characters,
            users,
            config,
            messageState
        } = data;
        this.characters = characters;
        this.user = users[0];
        this.variables = {};
        this.variableDefinitions = {};
        this.config = config;
        env.allowRemoteModels = false;

        this.readMessageState(messageState);
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {

        try {
            this.classificationPipeline = await pipeline("zero-shot-classification", "Xenova/mobilebert-uncased-mnli");
        } catch (exception: any) {
            console.error(`Error loading pipeline: ${exception}`);
        }

        let yamlResponse = await fetch('chub_meta.yaml');
        const data: any = yaml.load(await yamlResponse.text());

        const variableDefinitions: VariableDefinition[] = JSON.parse(this.config.variableConfig ?? data.config_schema.properties.variableConfig.value);

        for (const definition of variableDefinitions) {
            this.variableDefinitions[definition.name] = definition;
            console.log('Found variable definition: ' + this.variableDefinitions[definition.name])
        }

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

    async processVariables(content: string, contentSource: string) {
        for (const entry of Object.values(this.variableDefinitions)) {
            console.log('Variable:' + entry);
            // Generate variable if not present.
            if (!this.variables[entry.name]) {
                console.log('Initialize variable');
                this.variables[entry.name] = new Variable(entry.name, this.variableDefinitions);
            }

            let variable = this.variables[entry.name];
            if ([contentSource, 'both', ''].includes(entry.source.trim().toLowerCase())) {
                console.log('process');
                let updateFormula = entry.defaultUpdate;
                if (entry.assessmentMap && Object.keys(entry.assessmentMap).length > 0) {
                    this.classificationPipeline.task = entry.assessmentPrompt;
                    let response = await this.classificationPipeline(content, Object.keys(entry.assessmentMap), { multi_label: true });
                    console.log(response);
                    updateFormula = response.scores[0] >= entry.assessmentThreshold ? entry.assessmentMap[response.labels[0]] : updateFormula;
                }
                console.log('post pipeline');
                const valueMap: {[key: string]: any} = Object.entries(this.variables)
                    .map((result:{[key: string]: any}, key) => {
                        result[key] = this.variables[key].value;
                        return result;
                    });
                console.log(valueMap);
                console.log(`Before: ${variable.value}`);
                variable.value = this.parser.parse(this.replaceTags(updateFormula, valueMap));
                console.log(`After: ${variable.value}`);
            }
        }
    }

    replaceTags(source: string, replacements: {[name: string]: string}) {
        return source.replace(/{{([A-z]*)}}/g, (match) => {
            return replacements[match.substring(2, match.length - 2)];
        });
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {

        const {
            content,
            anonymizedId,
            isBot
        } = userMessage;
        console.log('start beforePrompt');
        await this.processVariables(content, 'input');
        console.log('finished beforePrompt');
        return {
            stageDirections: null,
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
            anonymizedId,
            isBot
        } = botMessage;
        console.log('start afterResponse');
        await this.processVariables(content, 'response');
        console.log('finished afterResponse');
        return {
            stageDirections: null,
            messageState: this.writeMessageState(),
            modifiedMessage: null,
            error: null,
            systemMessage: null,
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
