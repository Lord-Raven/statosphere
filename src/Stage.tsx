import {ReactElement} from "react";
import {Character, InitialData, Message, StageBase, StageResponse, User} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";
import {all, create, factory, FactoryFunctionMap} from "mathjs";
import {Variable, VariableDefinition} from "./Variable";
import * as yaml from 'js-yaml';
import {Client} from "@gradio/client";
import {ContentCategory, ContentRule} from "./ContentRule";
import {Classification, Classifier} from "./Classifier";
import {env, pipeline} from "@xenova/transformers";
import Ajv from "ajv";
import classifierSchema from "./assets/classifier-schema.json";
import contentSchema from "./assets/content-schema.json";
import functionSchema from "./assets/function-schema.json";
import variableSchema from "./assets/variable-schema.json";
import {CustomFunction} from "./CustomFunction";
type MessageStateType = any;
type ConfigType = any;
type InitStateType = any;
type ChatStateType = any;

const math = create(all, {matrix: 'Array'});

export function stripComments(input: string) {
    if (!input) return input;
    // Remove single-line comments
    input = input.replace(/\/\/.*$/gm, '');

    // Remove block comments
    input = input.replace(/\/\*[\s\S]*?\*\//g, '');

    return input;
}

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {

    readonly DEFAULT_THRESHOLD = 0.8;

    // message-level variables:
    variables: {[key: string]: any}
    // other:
    config: any;
    variableDefinitions: {[key: string]: VariableDefinition};
    contentRules: ContentRule[];
    classifiers: Classifier[];
    characters: {[key: string]: Character};
    user: User;
    client: any;
    fallbackPipelinePromise: Promise<any> | null = null;
    fallbackPipeline: any;
    fallbackMode: boolean;
    debugMode: boolean;
    evaluate: any;
    content: string = '';
    functions: {[key: string]: Function};
    customFunctionMap: any;

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);
        const {
            characters,
            users,
            config,
            messageState
        } = data;
        console.log('Constructing Statosphere');
        this.characters = characters;
        this.user = users[Object.keys(users)[0]];
        this.variables = {};
        this.variableDefinitions = {};
        this.functions = {};
        this.contentRules = [];
        this.classifiers = [];
        this.config = config;
        this.debugMode = false;
        this.fallbackMode = false; // Backend temporarily disabled by default.
        this.fallbackPipeline = null;
        env.allowRemoteModels = false;

        // Set up mathjs:
        this.customFunctionMap = {
            contains: function contains(a: any, b: any) {
                //console.log(`contains: ${a}, ${b}`);
                if (typeof a === 'string' && typeof b === 'string') {
                    return a.toLowerCase().includes(b.toLowerCase());
                }
                return a.includes(b);
            },
            capture: function capture(input: string, regex: string) {
                let matches = [...input.matchAll(new RegExp(regex, 'g'))];
                return matches && matches.length > 0 ? matches.map(match => match.slice(1)) : null;
            },
            replace: function replace(input: string, oldValue: string, newValue: string) {
                return input.replace(new RegExp(oldValue, 'g'), newValue);
            },
            join: function join(a: any[], b: string) {
                if (a) {
                    return a.join(b);
                } else {
                    return '';
                }
            },
            testFunctionDos: function testFunctionDos() {console.log('okay...');return true;},
            testFunction: new Function('testFunctionDos', 'return (testFunctionDos());')

        };
        math.import(this.customFunctionMap);
        this.evaluate = math.evaluate;

        this.readMessageState(messageState);
        console.log('Constructor complete');
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {

        console.log('Loading Statosphere...');
        let yamlResponse = await fetch('chub_meta.yaml');
        const data: any = yaml.load(await yamlResponse.text());
        console.log('Validate functions');
        Object.values(this.validateSchema(this.config.functionConfig ?? data.config_schema.properties.functionConfig.value, functionSchema, 'function schema'))
            .forEach(funcData => {
                let customFunction = new CustomFunction(funcData);
                let dependencies: any = [];
                let dependencyFunctions: any ={};
                Object.keys(this.functions).filter(key => customFunction.body.includes(`${key}(`)).forEach(dep => {
                    dependencies.push(dep);
                    dependencyFunctions[dep] = this.functions[dep];
                });
                this.functions[customFunction.name] = customFunction.createFunction();

                console.log(`${customFunction.name} dependencies: ${dependencies}`);

                this.customFunctionMap[`${customFunction.name}`] = factory(customFunction.name, dependencies, (dependencyFunctions) => customFunction.createFunction());
            });

        //this.customFunctionMap[`testFunction`] = factory('testFunction', [], () => function testFunction() {return true;});
        console.log(this.customFunctionMap);
        //math.import(this.customFunctionMap);
        this.evaluate = math.evaluate;
        //this.evaluate = create(this.customFunctionMap, {matrix: 'Array'}).evaluate;

        console.log('Validate variables');
        const variableDefinitions: VariableDefinition[] =
            this.validateSchema(this.config.variableConfig ?? data.config_schema.properties.variableConfig.value, variableSchema, 'variable schema');
        console.log('For through them');
        for (const definition of variableDefinitions) {
            this.variableDefinitions[definition.name] = new VariableDefinition(definition);
            if (!this.variables[definition.name]) {
                this.initializeVariable(definition.name);
            }
        }

        console.log('Validate content modifiers');
        Object.values(this.validateSchema(this.config.contentConfig ?? data.config_schema.properties.contentConfig.value, contentSchema, 'content schema'))
            .forEach(contentRule => this.contentRules.push(new ContentRule(contentRule)));

        console.log('Validate classifiers');
        Object.values(this.validateSchema(this.config.classifierConfig ?? data.config_schema.properties.classifierConfig.value, classifierSchema, 'classifier schema'))
            .forEach(classifier => this.classifiers.push(new Classifier(classifier)));

        if (this.classifiers.length > 0) {
            console.log('Load classifier pipeline');
            // Only bother loading pipeline if classifiers exist.
            this.fallbackPipelinePromise = this.getPipeline();

            // Update variables that are updated by classifiers to never be constant.
            for (let classifier of Object.values(this.classifiers)) {
                for (let classification of Object.values(classifier.classifications)) {
                    for (let variableName of Object.keys(classification.updates)) {
                        if (this.variableDefinitions[variableName]) {
                            this.variableDefinitions[variableName].constant = false;
                        }
                    }
                }
            }

            console.log('Load backend client');
            this.client = await Client.connect("Ravenok/statosphere-backend", {hf_token: import.meta.env.VITE_HF_API_KEY});
            console.log('Loaded client');
        } else {
            console.log('No classifiers');
        }

        console.log('Finished loading Statosphere.');
        return {
            success: true,
            error: null,
            initState: null,
            chatState: null,
        };
    }

    async getPipeline() {
        return pipeline("zero-shot-classification", "Xenova/mobilebert-uncased-mnli");
    }

    validateSchema(inputJson: string, schema: any, schemaName: string): any {
        try {
            const validate = new Ajv({multipleOfPrecision: 2}).compile(schema);
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
            console.log(messageState.variables);
            this.variables = messageState.variables ?? {};
            // Initialize variables that maybe didn't exist when this message state was written.
            for (const definition of Object.values(this.variableDefinitions)) {
                if (!this.variables[definition.name]) {
                    this.initializeVariable(definition.name);
                }
            }
        }
    }

    writeMessageState(): MessageStateType {
        console.log(Object.entries(this.variables).filter(([key, value]) => this.variableDefinitions[key] && !this.variableDefinitions[key].constant));
        return {
            variables: Object.entries(this.variables).filter(([key, value]) => this.variableDefinitions[key] && !this.variableDefinitions[key].constant)
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
        let finalFormula = this.replaceTags(formula, {});
        console.log(`Update ${name}: ${finalFormula}`);// = ${this.evaluate(finalFormula)}`);
        this.setVariable(name, this.evaluate(`(${finalFormula})`));
    }

    initializeVariable(name: string) {
        this.variables[name] = new Variable(name, this.variableDefinitions, this);
    }

    async processVariablesPerTurn() {
        for (const entry of Object.values(this.variableDefinitions)) {
            if (entry.perTurnUpdate) {
                console.log(`${entry.name} per turn update: ${entry.perTurnUpdate}`)
                try {
                    this.updateVariable(entry.name, entry.perTurnUpdate);
                } catch(error) {
                    console.log(error);
                }
            }
        }
    }

    async processVariablesPostInput() {
        for (const entry of Object.values(this.variableDefinitions)) {
            if (entry.postInputUpdate) {
                console.log(`${entry.name} post input update: ${entry.postInputUpdate}`)
                try {
                    this.updateVariable(entry.name, entry.postInputUpdate);
                } catch(error) {
                    console.log(error);
                }
            }
        }
    }

    async processVariablesPostResponse() {
        for (const entry of Object.values(this.variableDefinitions)) {
            if (entry.postResponseUpdate) {
                console.log(`${entry.name} post response update: ${entry.postResponseUpdate}`)
                try {
                    this.updateVariable(entry.name, entry.postResponseUpdate);
                } catch(error) {
                    console.log(error);
                }
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
                    if (response.scores[i] >= Math.max(classification.threshold ?? this.DEFAULT_THRESHOLD, categoryScores[classification.category ?? classification.label] ?? 0)) {
                        selectedClassifications[classification.category ?? classification.label] = classification;
                        categoryScores[classification.category ?? classification.label] = response.scores[i];
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
            const stringVal = typeof this.getVariable(key) === 'object' ? JSON.stringify(this.getVariable(key)) : this.getVariable(key);
            //console.log(`${typeof this.getVariable(key)}:${stringVal}`)
            replacements[key.toLowerCase()] = stringVal;
        }
        replacements['content'] = this.content ? this.content.replace(/"/g, '\\"') : this.content;
        return source.replace(/{{([A-z]*)}}/g, (match) => {
            //console.log('Subbing:' + source + ':' + match.substring(2, match.length - 2).toLowerCase() + ":" + replacements[match.substring(2, match.length - 2).toLowerCase()]);
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
            if (this.fallbackPipeline == null) {
                this.fallbackPipeline = this.fallbackPipelinePromise ? await this.fallbackPipelinePromise : await this.getPipeline();
            }
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

        const replacements = {'user': this.user.name, 'char': (this.characters[promptForId ?? ''] ? this.characters[promptForId ?? ''].name : '')};

        this.content = content;
        await this.processClassifiers(content, 'input', promptForId ?? '');
        await this.processVariablesPostInput();

        Object.values(this.contentRules).forEach(contentRule => this.content = contentRule.evaluateAndApply(this, ContentCategory.Input, replacements));
        const modifiedMessage = this.content;

        this.content = '';
        Object.values(this.contentRules).forEach(contentRule => this.content = contentRule.evaluateAndApply(this, ContentCategory.StageDirection, replacements));
        const stageDirections = this.content;

        console.log('End beforePrompt()');
        return {
            stageDirections: stageDirections.trim() != '' ? `[Response Hints]${stageDirections}\n[/Response Hints]` : null,
            messageState: this.writeMessageState(),
            modifiedMessage: modifiedMessage,
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

        this.content = content;
        await this.processClassifiers(content, 'response', anonymizedId);
        await this.processVariablesPostResponse();

        const replacements = {'user': this.user.name, 'char': (this.characters[anonymizedId] ? this.characters[anonymizedId].name : '')};
        Object.values(this.contentRules).forEach(contentRule => this.content = contentRule.evaluateAndApply(this, ContentCategory.Response, replacements));
        const modifiedMessage = this.content;

        this.content = '';
        Object.values(this.contentRules).forEach(contentRule => this.content = contentRule.evaluateAndApply(this, ContentCategory.SystemMessage, replacements));

        console.log(`End afterResponse()`);
        return {
            stageDirections: null,
            messageState: this.writeMessageState(),
            modifiedMessage: modifiedMessage,
            error: null,
            systemMessage: this.content.trim() != '' ? this.content : null,
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
