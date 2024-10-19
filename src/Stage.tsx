import {ReactElement} from "react";
import {Character, InitialData, Message, StageBase, StageResponse, TextResponse, User} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";
import {all, create} from "mathjs";
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
import generatorSchema from "./assets/generator-schema.json";
import variableSchema from "./assets/variable-schema.json";
import {CustomFunction} from "./CustomFunction";
import {Generator, Phase} from "./Generator";
type MessageStateType = any;
type ConfigType = any;
type InitStateType = any;
type ChatStateType = any;

const math = create(all, {matrix: 'Array'});

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {

    readonly DEFAULT_THRESHOLD = 0.7;

    // message-level variables:
    variables: {[key: string]: any}
    // other:
    config: any;
    variableDefinitions: {[key: string]: VariableDefinition};
    contentRules: ContentRule[];
    classifiers: Classifier[];
    generators: Generator[];
    characters: {[key: string]: Character};
    user: User;
    client: any;
    fallbackPipelinePromise: Promise<any> | null = null;
    fallbackPipeline: any;
    fallbackMode: boolean;
    debugMode: boolean;
    evaluate: any;
    content: string = '';
    functions: {[key: string]: CustomFunction};
    customFunctionMap: any;
    scope: {[key: string]: any};
    replacements: any = {};

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
        this.replacements = {'user': this.user.name, 'char': Object.values(this.characters)[0].name};
        this.variables = {};
        this.variableDefinitions = {};
        this.functions = {};
        this.contentRules = [];
        this.classifiers = [];
        this.generators = [];
        this.config = config;
        this.debugMode = false;
        this.fallbackMode = false;
        this.fallbackPipeline = null;
        this.scope = {};
        env.allowRemoteModels = false;

        this.customFunctionMap = {};
        this.evaluate = math.evaluate;

        this.readMessageState(messageState);
        console.log('Constructor complete');
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {

        console.log('Loading Statosphere...');
        let yamlResponse = await fetch('chub_meta.yaml');
        const data: any = yaml.load(await yamlResponse.text());

        console.log('Loading configuration');
        const configJson = JSON.parse(this.config.configJson ?? data.config_schema.properties.configJson.value);
        console.log(configJson);
        const classifierJson = configJson.classifiers ?? [];
        const contentJson = configJson.content ?? [];
        const functionJson = configJson.functions ?? [];
        const generatorJson = configJson.generators ?? [];
        const variableJson = configJson.variables ?? [];

        console.log('Validate functions');
        // Build basic functions
        this.functions = {
            contains: new CustomFunction({name: 'contains', parameters: 'haystack, needle', body: `\
                        if (typeof haystack === 'string' && typeof needle === 'string') {
                            return haystack.toLowerCase().includes(needle.toLowerCase());
                        }
                        return haystack.includes(needle);`
            }, this),
            capture: new CustomFunction({name: 'capture', parameters: 'input, regex, regexFlags', body: `\
                        let matches = [...input.matchAll(new RegExp(regex, regexFlags ? regexFlags : 'g'))];
                        return matches && matches.length > 0 ? matches.map(match => match.slice(1)) : null;`
            }, this),
            replace: new CustomFunction({name: 'replace', parameters: 'input, regex, newValue', body: `\
                        return input.replace(new RegExp(regex, 'g'), newValue);`
            }, this),
            join: new CustomFunction({name: 'join', parameters: 'arrayToJoin, separator', body: `\
                        if (arrayToJoin) {
                            return arrayToJoin.join(separator);
                        } else {
                            return '';
                        }`
            }, this)
        };

        // Load additional functions
        Object.values(this.validateSchema(functionJson, functionSchema, 'function schema'))
            .forEach(funcData => {
                let customFunction = new CustomFunction(funcData, this);
                this.functions[customFunction.name] = customFunction;
            });
        // Update based on dependencies:
        Object.values(this.functions).forEach(thisFunction => {
            let newDependencies = thisFunction.name;

            while (newDependencies.length > 0) {
                thisFunction.dependencies = `${thisFunction.dependencies},${newDependencies}`;

                const splitDependencies = newDependencies.split(',');
                newDependencies = '';
                splitDependencies.map(otherName => this.functions[otherName]).filter(otherFunc => otherFunc).forEach(otherFunc => {
                    // Looking at each function in new dependencies to check for their dependencies.
                    Object.keys(this.functions).filter(thirdKey => otherFunc.body.includes(`${thirdKey}(`)).forEach(potentialDependency => {
                        if (!thisFunction.dependencies.includes(potentialDependency)) {
                            newDependencies = `${newDependencies},${potentialDependency}`;
                        }
                    });
                });
            }
            thisFunction.dependencies = thisFunction.dependencies.replace(/,,/g, ',');
        });
        // All dependencies updated; now persist arguments to calls:
        Object.values(this.functions).forEach(thisFunction => {
            thisFunction.body = this.updateFunctionArguments(thisFunction.body);
            try {
                this.customFunctionMap[`${thisFunction.name}`] = thisFunction.createFunction();
            } catch (error) {
                console.log(error);
                console.log('Encountered the above error while creating this function from configuration:');
                console.log(`${thisFunction.parameters} ${thisFunction.dependencies}`);
                console.log(thisFunction.body);
            }
        });

        math.import(this.customFunctionMap);
        this.evaluate = math.evaluate;
        //this.evaluate = create(this.customFunctionMap, {matrix: 'Array'}).evaluate;

        console.log('Validate variables');
        const variableDefinitions: VariableDefinition[] =
            this.validateSchema(variableJson, variableSchema, 'variable schema');
        for (const definition of variableDefinitions) {
            try {
                this.variableDefinitions[definition.name] = new VariableDefinition(definition, this);
                if (!this.variables[definition.name]) {
                    this.initializeVariable(definition.name);
                }
            } catch(error) {
                console.log(error);
                console.log('Encountered the above error while creating variable');
                console.log(definition);
            }
        }

        console.log('Validate generators');
        Object.values(this.validateSchema(generatorJson, generatorSchema, 'generator schema'))
            .forEach(generator => this.generators.push(new Generator(generator, this)));
        // Update variables that are updated by generators to never be constant.
        for (let generator of Object.values(this.generators)) {
            for (let variableName of Object.keys(generator.updates)) {
                if (this.variableDefinitions[variableName]) {
                    this.variableDefinitions[variableName].constant = false;
                }
            }
        }
        const generatorPromises = this.kickOffGenerators(Phase.Initialization);

        console.log('Validate content modifiers');
        Object.values(this.validateSchema(contentJson, contentSchema, 'content schema'))
            .forEach(contentRule => this.contentRules.push(new ContentRule(contentRule, this)));

        console.log('Validate classifiers');
        Object.values(this.validateSchema(classifierJson, classifierSchema, 'classifier schema'))
            .forEach(classifier => this.classifiers.push(new Classifier(classifier, this)));

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

        await this.processGenerators(generatorPromises);

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

    validateSchema(data: any, schema: any, schemaName: string): any {
        try {
            const validate = new Ajv({multipleOfPrecision: 2}).compile(schema);
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
                    console.log(`Initializing variable in readMessageState: ${definition.name}`);
                    this.initializeVariable(definition.name);
                }
            }
        }
    }

    writeMessageState(): MessageStateType {
        let savedVariables = Object.fromEntries(Object.entries(this.variables).filter(([key, value]) => this.variableDefinitions[key] && !this.variableDefinitions[key].constant));
        console.log(savedVariables);
        return {
            variables: savedVariables
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
        try {
            let finalFormula = this.replaceTags(formula);
            this.setVariable(name, this.evaluate(`(${finalFormula})`, this.buildScope()));
        } catch (error) {
            console.log(error);
            console.log(this.replaceTags(formula));
        }
    }

    initializeVariable(name: string) {
        this.variables[name] = new Variable(name, this.variableDefinitions, this);
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

    async processClassifiers(content: string, contentSource: string) {
        for (const classifier of Object.values(this.classifiers)) {

            let sequenceTemplate = this.replaceTags((contentSource == 'input' ? classifier.inputTemplate : classifier.responseTemplate) ?? '');
            sequenceTemplate = sequenceTemplate.trim() == '' ? content : sequenceTemplate.replace('{}', content);
            let hypothesisTemplate = this.replaceTags((contentSource == 'input' ? classifier.inputHypothesis : classifier.responseHypothesis) ?? '');
            // No hypothesis (this classifier doesn't apply to this contentSource) or condition set but not true):
            if (hypothesisTemplate.trim() == '' || (classifier.condition != '' && !this.evaluate(this.replaceTags(classifier.condition ?? 'true'), this.scope))) {
                continue;
            }
            let candidateLabels: string[] = [];
            let labelMapping: { [key: string]: string } = {};
            for (const label of Object.keys(classifier.classifications)) {
                let dynamicLabels = this.evaluate(`(${this.replaceTags(label)})`);
                if (typeof dynamicLabels === 'string') {
                    dynamicLabels = [dynamicLabels];
                }
                if (Array.isArray(dynamicLabels)) {
                    for (let dynamicLabel in dynamicLabels) {
                        candidateLabels.push(dynamicLabel);
                        labelMapping[dynamicLabel] = label;
                    }
                }
            }

            let response = await this.query({sequence: sequenceTemplate, candidate_labels: candidateLabels, hypothesis_template: hypothesisTemplate, multi_label: true});

            let specificLabels: {[key: string]: string} = {};
            let selectedClassifications: {[key: string]: Classification} = {};
            let categoryScores: {[key: string]: number} = {};
            for (let i = 0; i < response.labels.length; i++) {
                const classification = classifier.classifications[labelMapping[response.labels[i]]];
                if (response.scores[i] >= Math.max(classification.threshold ?? this.DEFAULT_THRESHOLD, categoryScores[classification.category ?? classification.label] ?? 0)) {
                    selectedClassifications[classification.category ?? classification.label] = classification;
                    specificLabels[classification.category ?? classification.label] = response.labels[i];
                    categoryScores[classification.category ?? classification.label] = response.scores[i];
                }
            }

            // Go through all operations and execute them.
            for (let key of Object.keys(selectedClassifications)) {
                const classification = selectedClassifications[key];
                for (let variable of Object.keys(classification.updates)) {
                    this.replacements['label'] = specificLabels[key];
                    this.updateVariable(variable, classification.updates[variable]);
                }
            }
        }
    }

    kickOffGenerators(phase: Phase): {[key: string]: Promise<TextResponse|null>} {
        let promises: {[key: string]: Promise<TextResponse|null>} = {};
        for (const generator of Object.values(this.generators)) {
            if (generator.phase == phase && (generator.condition == '' || this.evaluate(this.replaceTags(generator.condition ?? 'true'), this.buildScope()))) {
                console.log('Kicking off a generator with prompt: ' + generator.prompt);
                promises[generator.name] = this.generator.textGen({prompt: generator.prompt, min_tokens: generator.minTokens, max_tokens: generator.maxTokens});
            }
        }
        return promises;
    }

    async processGenerators(promises: {[key: string]: Promise<TextResponse|null>}) {
        for (const generator of Object.values(this.generators)) {

            if (generator.name in promises) {
                const response = await promises[generator.name];
                if (response && response.result && response.result != '') {
                    console.log(`Received response for generator ${generator.name}: ${response.result}`);
                    this.content = response.result;
                    for (let variable of Object.keys(generator.updates)) {
                        this.updateVariable(variable, generator.updates[variable]);
                    }
                } else {
                    console.log(`Empty response for generator ${generator.name}:`);
                    console.log(response);
                }
            }
        }
    }

    replaceTags(source: string) {
        let replacements = this.replacements;
        for (const key of Object.keys(this.variables)) {
            replacements[key.toLowerCase()] = (typeof this.getVariable(key) === 'object' ? JSON.stringify(this.getVariable(key)) : this.getVariable(key));
        }
        replacements['content'] = this.content ? this.content.replace(/"/g, '\\"') : this.content;
        return source.replace(/{{([A-z]*)}}/g, (match) => {
            return replacements[match.substring(2, match.length - 2).toLowerCase()];
        });
    }

    async query(data: any) {
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
        const previousBackground = this.scope.background ?? '';

        this.replacements = {'user': this.user.name, 'char': (this.characters[promptForId ?? ''] ? this.characters[promptForId ?? ''].name : '')};

        await this.processVariablesPerTurn();
        const generatorPromises = this.kickOffGenerators(Phase.OnInput);

        this.content = content;
        await this.processClassifiers(content, 'input');
        await this.processVariablesPostInput();

        this.buildScope();

        Object.values(this.contentRules).forEach(contentRule => this.content = contentRule.evaluateAndApply(this, ContentCategory.Input));
        const modifiedMessage = this.content;


        this.content = '';
        Object.values(this.contentRules).forEach(contentRule => this.content = contentRule.evaluateAndApply(this, ContentCategory.PostInput));
        const systemMessage = this.content;

        await this.processGenerators(generatorPromises);

        this.content = '';
        Object.values(this.contentRules).forEach(contentRule => this.content = contentRule.evaluateAndApply(this, ContentCategory.StageDirection));
        const stageDirections = this.content;

        if (previousBackground != this.scope.background ?? '') {
            console.log(`Background changing from ${previousBackground} to ${this.scope.background}`);
            await this.messenger.updateEnvironment({background: this.scope.background ?? ''});
        }
        console.log('End beforePrompt()');
        return {
            stageDirections: stageDirections.trim() != '' ? `[RESPONSE INSTRUCTION]${stageDirections}\n[/RESPONSE INSTRUCTION]` : null,
            messageState: this.writeMessageState(),
            modifiedMessage: modifiedMessage,
            systemMessage: systemMessage.trim() != '' ? systemMessage : null,
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
        const previousBackground = this.scope.background ?? '';

        this.replacements = {'user': this.user.name, 'char': (this.characters[anonymizedId] ? this.characters[anonymizedId].name : '')};
        const generatorPromises = this.kickOffGenerators(Phase.OnResponse);

        this.content = content;
        await this.processClassifiers(content, 'response');
        await this.processVariablesPostResponse();

        this.buildScope();


        Object.values(this.contentRules).forEach(contentRule => this.content = contentRule.evaluateAndApply(this, ContentCategory.Response));
        const modifiedMessage = this.content;

        this.content = '';
        Object.values(this.contentRules).forEach(contentRule => this.content = contentRule.evaluateAndApply(this, ContentCategory.PostResponse));
        const systemMessage = this.content;

        await this.processGenerators(generatorPromises);

        if (previousBackground != this.scope.background ?? '') {
            console.log(`Background changing from ${previousBackground} to ${this.scope.background}`);
            await this.messenger.updateEnvironment({background: this.scope.background ?? ''});
        }
        console.log(`End afterResponse()`);
        return {
            stageDirections: null,
            messageState: this.writeMessageState(),
            modifiedMessage: modifiedMessage,
            error: null,
            systemMessage: systemMessage.trim() != '' ? systemMessage : null,
            chatState: null
        };
    }

    processCode(input: string) {
        return this.updateFunctionArguments(this.stripComments(input));
    }

    stripComments(input: string) {
        if (!input) return input;
        // Remove single-line comments
        input = input.replace(/ \/\/.*$/gm, '');

        // Remove block comments
        input = input.replace(/\/\*[\s\S]*?\*\//g, '');

        return input;
    }

    updateFunctionArguments(input: string) {
        if (!input) return input;
        Object.values(this.functions).forEach(knownFunction => {
            let start = input.indexOf(`${knownFunction.name}(`);
            while(start > -1) {
                let index = start + knownFunction.name.length + 1;
                let parens = 1;
                while (index < input.length && parens > 0) {
                    switch(input.charAt(index)) {
                        case '(':
                            parens++;
                            break;
                        case ')':
                            parens--;
                            break;
                        default:
                            break;
                    }
                    if (parens != 0) {
                        index++;
                    }
                }
                input = input.slice(0, index) + knownFunction.dependencies + input.slice(index);
                start = input.indexOf(`${knownFunction.name}(`, index);
            }
        });
        // Clean up functions with no initial parameter "(,"
        input = input.replace(/\(,/g, '(');

        return input;
    }

    buildScope() {
        this.scope = Object.entries(this.variables).reduce((acc, [key, value]) => {
            acc[key] = value.value;
            return acc;
        }, {} as {[key: string]: any});
        return this.scope;
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
