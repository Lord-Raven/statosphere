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
import {env, pipeline} from "@xenova/transformers";
import Ajv from "ajv";
import classifierSchema from "./assets/classifier-schema.json";
import promptSchema from "./assets/prompt-schema.json";
import variableSchema from "./assets/variable-schema.json";

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
    fallbackMode: boolean;
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
        this.fallbackMode = false; // Backend temporarily disabled by default.
        this.fallbackPipeline = null;
        env.allowRemoteModels = false;

        this.readMessageState(messageState);
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {

        try {
            this.fallbackPipeline = await pipeline("zero-shot-classification", "Xenova/mobilebert-uncased-mnli");
        } catch (exception: any) {
            console.error(`Error loading pipeline: ${exception}`);
        }
        let yamlResponse = await fetch('chub_meta.yaml');
        const data: any = yaml.load(await yamlResponse.text());

        const variableDefinitions: VariableDefinition[] =
            this.validateSchema(this.config.variableConfig ?? data.config_schema.properties.variableConfig.value, variableSchema, 'variable schema');
        for (const definition of variableDefinitions) {
            this.variableDefinitions[definition.name] = new VariableDefinition(definition);
            if (!this.variables[definition.name]) {
                this.initializeVariable(definition.name);
            }
        }
        Object.values(this.validateSchema(this.config.promptConfig ?? data.config_schema.properties.promptConfig.value, promptSchema, 'prompt schema'))
            .forEach(promptRule => this.promptRules.push(new PromptRule(promptRule)));
        Object.values(this.validateSchema(this.config.classifierConfig ?? data.config_schema.properties.classifierConfig.value, classifierSchema, 'classifier schema'))
            .forEach(classifier => this.classifiers.push(new Classifier(classifier)));

        this.displayMessage = this.config.displayMessage ?? data.config_schema.properties.displayMessage.value ?? '';

        this.client = await Client.connect("Ravenok/statosphere-backend", {hf_token: import.meta.env.VITE_HF_API_KEY});

        console.log('Finished loading stage.');
        return {
            success: true,
            error: null,
            initState: null,
            chatState: null,
        };
    }

    validateSchema(inputJson: string, schema: any, schemaName: string): any {
        try {
            const validate = new Ajv().compile(schema);
            const data = JSON.parse(inputJson);
            const valid = validate(data);
            if (valid) {
                return data;
            } else {
                console.log(`Configuration JSON validation failed against ${schemaName}.`, validate.errors);
            }
        } catch (error) {
            console.log(`Invalid JSON string validating ${schemaName}.`, error);
        }
        return {};
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

    async processVariablesPerTurn() {
        for (const entry of Object.values(this.variableDefinitions)) {
            if (entry.perTurnUpdate) {
                this.updateVariable(entry.name, entry.perTurnUpdate);
            }
        }
    }

    async processVariablesPostInput() {
        for (const entry of Object.values(this.variableDefinitions)) {
            if (entry.postInputUpdate) {
                this.updateVariable(entry.name, entry.postInputUpdate);
            }
        }
    }

    async processVariablesPostResponse() {
        for (const entry of Object.values(this.variableDefinitions)) {
            if (entry.postResponseUpdate) {
                this.updateVariable(entry.name, entry.postResponseUpdate);
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
                let candidateLabels: string[] = [];
                let labelMapping: { [key: string]: string } = {};
                for (const label of Object.keys(classifier.classifications)) {
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
        if (this.client && !this.fallbackMode) {
            try {
                const response = await this.client.predict("/predict", {data_string: JSON.stringify(data)});
                result = JSON.parse(`${response.data[0]}`);
            } catch(e) {
                console.log(e);
            }
        }
        if (!result) {
            console.log('Falling back to local zero-shot pipeline.');
            this.fallbackMode = true;
            result = await this.fallbackPipeline(data.sequence, data.candidate_labels, { hypothesis_template: data.hypothesis_template, multi_label: data.multi_label });
        }
        console.log(result);
        return result;
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {

        const {
            content,
            promptForId
        } = userMessage;
        console.log('Start beforePrompt()');
        await this.processVariablesPerTurn();

        await this.processClassifiers(content, 'input', promptForId ?? '');

        await this.processVariablesPostInput();

        let stageDirections = this.replaceTags('' + Object.values(this.promptRules).map(promptRule => promptRule.evaluate(this)).filter(prompt => prompt.trim().length > 0).join('\n'), {'user': this.user.name, 'char': (this.characters[promptForId ?? ''] ? this.characters[promptForId ?? ''].name : '')});

        console.log('End beforePrompt()');
        return {
            stageDirections: stageDirections != '' ? `[Response Hints]\n${stageDirections}\n[/Response Hints]` : null,
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
        console.log('Start afterResponse()');
        await this.processClassifiers(content, 'response', anonymizedId);
        console.log(`End afterResponse()`);
        await this.processVariablesPostResponse();
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
