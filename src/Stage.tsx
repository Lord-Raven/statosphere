import {ReactElement} from "react";
import {
    Character,
    ImagineResponse,
    InitialData,
    Message,
    StageBase,
    StageResponse,
    TextResponse,
    User
} from "@chub-ai/stages-ts";
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
import {Generator, GeneratorPhase, GeneratorType} from "./Generator";
import {Howl} from "howler";

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
    classifiers: {[key: string]: Classifier};
    generators: {[key: string]: Generator};
    classifierLabelMapping: {[key: string]: {[key: string]: string}};

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
    background: any = undefined;
    musicUrl: string = '';
    music: Howl|null = null;


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
        this.classifiers = {};
        this.generators = {};
        this.classifierLabelMapping = {};
        this.config = config;
        this.debugMode = false
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

        // Need to load variable names first, to determine function dependencies
        console.log('Validate variables');
        const variableDefinitions: VariableDefinition[] =
            this.validateSchema(variableJson, variableSchema, 'variable schema');

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
                        const matches = [...input.matchAll(new RegExp(regex, regexFlags ? regexFlags : 'g'))];
                        return matches && matches.length > 0 ? matches.map(match => match.slice(1)) : [];`
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
                    Object.values(variableDefinitions).map(definition => definition.name).forEach(potentialDependency => {
                        const regex = new RegExp(`\\b${potentialDependency}\\b`);
                        if (regex.test(otherFunc.body) && !thisFunction.dependencies.includes(potentialDependency)) {
                            newDependencies = `${newDependencies},${potentialDependency}`;
                        }
                    })
                });
            }
            thisFunction.dependencies = thisFunction.dependencies.replace(/,,/g, ',');
        });
        // All dependencies updated; now persist arguments to calls:
        Object.values(this.functions).forEach(thisFunction => {
            thisFunction.body = this.updateFunctionArguments(thisFunction.body);
            try {
                //console.log(`Built function ${thisFunction.name}(${thisFunction.parameters}${thisFunction.dependencies}) {\n${thisFunction.body}\n}`);
                this.customFunctionMap[`${thisFunction.name}`] = thisFunction.createFunction();
            } catch (error) {
                console.log(error);
                console.log(`Encountered the above error while creating function\n${thisFunction.name}(${thisFunction.parameters}${thisFunction.dependencies}) {\n${thisFunction.body}\n}`);
            }
        });

        try {
            math.import(this.customFunctionMap, {override: true});
        } catch (e) {
            console.log(e);
        }

        this.evaluate = math.evaluate;
        //this.evaluate = create(this.customFunctionMap, {matrix: 'Array'}).evaluate;

        // Initialize variables; these were loaded/validated above but they could depend upon functions for initialization:
        console.log('Initialize variables');
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
            .forEach(generatorData => {
                const generator = new Generator(generatorData, this);
                this.generators[generator.name] = generator;
            });
        // Update variables that are updated by generators to never be constant.
        for (let generator of Object.values(this.generators)) {
            for (let variableName of Object.keys(generator.updates)) {
                if (this.variableDefinitions[variableName]) {
                    this.variableDefinitions[variableName].constant = false;
                }
            }
        }
        //this.resetRequestVariables();
        //this.kickOffRequests(GeneratorPhase.Initialization);

        console.log('Validate content modifiers');
        Object.values(this.validateSchema(contentJson, contentSchema, 'content schema'))
            .forEach(contentRule => this.contentRules.push(new ContentRule(contentRule, this)));

        console.log('Validate classifiers');
        Object.values(this.validateSchema(classifierJson, classifierSchema, 'classifier schema'))
            .forEach(classifierData => {const classifier = new Classifier(classifierData, this);this.classifiers[classifier.name] = classifier;});

        if (Object.values(this.classifiers).length > 0) {
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

        if (this.variables['debugMode']) {
            console.log('Debug mode enabled.');
            this.debugMode = true;
        }
        await this.checkBackground();

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

    async checkMusic() {
        if (this.debugMode && this.musicUrl != (this.scope.music ?? '')) {
            console.log(`Music check: ${this.musicUrl} vs. ${this.scope.music}`)
            this.musicUrl = this.scope.music ?? '';
            if (this.music) {
                this.music.fade(1, 0, 1000);
            }

            if (this.musicUrl != '') {
                console.log(`Playing music: ${this.musicUrl}`);
                this.music = new Howl({src: [this.musicUrl], loop: true, preload: true});
                this.music.play();
            }
        }
    }

    async playSound() {
        if (this.debugMode && this.scope.sound != null && this.scope.sound != '') {
            console.log(`Playing sound: ${this.scope.sound}`);
            const sfx = new Howl(this.scope.sound);
            sfx.play();
            this.scope.sound = '';
        }
    }

    async checkBackground() {
        if (this.background != this.scope.background ?? '') {
            console.log(`Background changing from ${this.background} to ${this.scope.background}`);
            await this.messenger.updateEnvironment({background: this.scope.background ?? ''});
            this.background = this.scope.background;
        }
    }

    async setState(state: MessageStateType): Promise<void> {
        this.readMessageState(state);
        await this.playSound();
        await this.checkMusic();
        await this.checkBackground();
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
        // console.log(savedVariables);
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

    async processVariablesPreInput() {
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

    async processVariablesPreResponse() {
        for (const entry of Object.values(this.variableDefinitions)) {
            if (entry.preResponseUpdate) {
                this.updateVariable(entry.name, entry.preResponseUpdate);
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

    resetGeneratorsAndClassifiers() {
        this.classifierLabelMapping = {};
        for (let generator of Object.values(this.generators)) {
            generator.skipped = false;
            generator.processed = false;
            generator.promise = null;
            generator.result = undefined;
        }

        for (let classifier of Object.values(this.classifiers)) {
            classifier.skipped = false;
            classifier.processed = false;
            classifier.promise = null;
            classifier.result = undefined;
        }
    }

    processRequests(phase: GeneratorPhase) {
        let finished: boolean = true;
        for (const classifier of Object.values(this.classifiers).filter(classifier => !classifier.isDone())) {
            // if this classifier is ready, process it.
            if (classifier.isReady()) {
                const response = classifier.result;
                let specificLabels: { [key: string]: string } = {};
                let selectedClassifications: { [key: string]: Classification } = {};
                let categoryScores: { [key: string]: number } = {};
                for (let i = 0; i < response.labels.length; i++) {
                    const classification = classifier.classifications[this.classifierLabelMapping[classifier.name][response.labels[i]]];
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
                classifier.processed = true;
            } else {
                finished = false;
                if (!classifier.isStarted()) {
                    this.kickOffClassifier(classifier, phase);
                }
            }
        }

        for (const generator of Object.values(this.generators).filter(generator => !generator.isDone())) {
            if (generator.isReady()) {
                this.applyGeneratorResponse(generator, generator.result);
                generator.processed = true;
            } else {
                finished = false;
                if (!generator.isStarted()) {
                    this.kickOffGenerator(generator, phase);
                }
            }
        }

        return finished;
    }

    kickOffClassifier(classifier: Classifier, phase: GeneratorPhase) {
        try {
            // If there are no dependencies that haven't completed, then this classifier can start.
            if (classifier.dependencies.filter(dependency => !((this.generators[dependency] ? this.generators[dependency].isDone() : true) && (this.classifiers[dependency] ? this.classifiers[dependency].isDone() : true))).length == 0) {
                let sequenceTemplate = this.replaceTags((phase == GeneratorPhase.OnInput ? classifier.inputTemplate : classifier.responseTemplate) ?? '');
                sequenceTemplate = sequenceTemplate.trim() == '' ? this.content : sequenceTemplate.replace('{}', this.content);
                let hypothesisTemplate = this.replaceTags((phase == GeneratorPhase.OnInput ? classifier.inputHypothesis : classifier.responseHypothesis) ?? '');
                // No hypothesis (this classifier doesn't apply to this contentSource) or condition set but not true):
                if (hypothesisTemplate.trim() == '' || (classifier.condition != '' && !this.evaluate(this.replaceTags(classifier.condition ?? 'true'), this.scope))) {
                    classifier.skipped = true;
                } else {
                    let candidateLabels: string[] = [];
                    let thisLabelMapping: { [key: string]: string } = {};
                    for (const label of Object.keys(classifier.classifications)) {
                        // The label key here does not contain code alterations, which are essential for dynamic labels; use the label from the classification object for substitution
                        let subbedLabel = this.replaceTags(classifier.classifications[label].label);

                        if (classifier.classifications[label].dynamic) {
                            try {
                                console.log(`Substituted label: ${subbedLabel}`);
                                let dynamicLabels = this.evaluate(subbedLabel, this.scope);
                                if (typeof dynamicLabels === 'string') {
                                    dynamicLabels = [dynamicLabels];
                                }
                                if (Array.isArray(dynamicLabels)) {
                                    for (let dynamicLabel of dynamicLabels) {
                                        candidateLabels.push(dynamicLabel);
                                        thisLabelMapping[dynamicLabel] = label;
                                    }
                                }
                            } catch (error) {
                                console.log(error);
                                console.log('Encountered the above error while processing a dynamic label: ' + subbedLabel);
                            }
                        } else {
                            candidateLabels.push(subbedLabel);
                            thisLabelMapping[subbedLabel] = label;
                        }
                    }

                    this.classifierLabelMapping[classifier.name] = thisLabelMapping;

                    const promise = this.query({
                        sequence: sequenceTemplate,
                        candidate_labels: candidateLabels,
                        hypothesis_template: hypothesisTemplate,
                        multi_label: true
                    });
                    promise.then(result => classifier.result = result).catch(reason => {console.log(reason); classifier.result = null;});
                    classifier.promise = promise;
                }
            }
        } catch (e) {
            console.error(e);
            console.log(`Encountered the above while processing classifier ${classifier.name}\nCondition: ${classifier.condition}`);
            classifier.skipped = true;
        }
    }

    kickOffGenerator(generator: Generator, phase: GeneratorPhase) {
        try {
            // If there are no dependencies that haven't completed, then this classifier can start.
            if (generator.dependencies.filter(dependency => !((this.generators[dependency] ? this.generators[dependency].isDone() : true) && (this.classifiers[dependency] ? this.classifiers[dependency].isDone() : true))).length == 0) {
                if (generator.phase == phase && (generator.condition == '' || this.evaluate(this.replaceTags(generator.condition ?? 'true'), this.buildScope()))) {
                    let promise;
                    if (generator.type == GeneratorType.Image) {
                        const prompt = this.evaluate(this.replaceTags(generator.prompt), this.scope);
                        const negativePrompt = this.evaluate(this.replaceTags(generator.negativePrompt), this.scope);
                        console.log('Kicking off an image generator with prompt:\n' + prompt);
                        promise = this.generator.makeImage({
                            prompt: prompt,
                            negative_prompt: negativePrompt,
                            aspect_ratio: generator.aspectRatio,
                            remove_background: generator.removeBackground
                        });

                    } else {
                        const prompt = this.evaluate(this.replaceTags(generator.prompt), this.scope);
                        console.log('Kicking off a text generator with prompt:\n' + prompt);
                        promise = this.generator.textGen({
                            prompt: prompt,
                            min_tokens: generator.minTokens,
                            max_tokens: generator.maxTokens,
                            include_history: generator.includeHistory
                        })
                    }
                    promise.then(response => generator.result = response).catch(reason => {console.log(reason); generator.result = null;});
                    generator.promise = promise;
                } else {
                    // No dependencies and criteria not met; skip this one.
                    generator.skipped = true;
                }
            }
        } catch (e) {
            console.error(e);
            console.log(`Encountered the above while processing generator ${generator.name}\nCondition: ${generator.condition}\nPrompt: ${generator.prompt}`);
            generator.skipped = true;
        }
    }

    applyGeneratorResponse(generator: Generator, response: TextResponse | ImagineResponse | null) {
        const result = response ? ('result' in response ? response.result : response.url) : '';
        if (result != '') {
            console.log(`Received response for generator ${generator.name}:\n${result}`);
            const backupContent = this.content;
            this.setContent(result);
            for (let variable of Object.keys(generator.updates)) {
                this.updateVariable(variable, generator.updates[variable]);
            }
            this.setContent(backupContent);
            generator.processed = true;
        } else {
            console.log(`Empty response for generator ${generator.name}`);
            generator.skipped = true;
        }
    }

    replaceTags(source: string) {
        let replacements = this.replacements;
        for (const key of Object.keys(this.variables)) {
            replacements[key.toLowerCase()] = (typeof this.getVariable(key) in ['object','string'] ? JSON.stringify(this.getVariable(key)) : this.getVariable(key));
        }
        replacements['content'] = this.content ? this.content.replace(/"/g, '\\"') : this.content;
        return source.replace(/{{([A-z]*)}}/g, (match) => {
            const variableName = match.substring(2, match.length - 2).toLowerCase()
            return (variableName in replacements ? replacements[variableName] : match);
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
            Client.connect("Ravenok/statosphere-backend", {hf_token: import.meta.env.VITE_HF_API_KEY}).then(client => {this.fallbackMode = false; this.client = client}).catch(err => console.log(err));

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

        this.replacements = {'user': this.user.name, 'char': (this.characters[promptForId ?? ''] ? this.characters[promptForId ?? ''].name : '')};

        console.log('Process pre-input variables');
        await this.processVariablesPreInput();

        console.log('Handle generators and classifiers');
        this.resetGeneratorsAndClassifiers()
        this.setContent(content);
        this.buildScope();
        while (!this.processRequests(GeneratorPhase.OnInput)) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        console.log('Process post-input variables')
        await this.processVariablesPostInput();

        this.buildScope();

        console.log('Apply input content rules');
        Object.values(this.contentRules).forEach(contentRule => this.setContent(contentRule.evaluateAndApply(this, ContentCategory.Input)));
        const modifiedMessage = this.content.trim() == '' ? '\n' : this.content;


        this.setContent('');
        Object.values(this.contentRules).forEach(contentRule => this.setContent(contentRule.evaluateAndApply(this, ContentCategory.PostInput)));
        const systemMessage = this.content;


        this.setContent('');
        Object.values(this.contentRules).forEach(contentRule => this.setContent(contentRule.evaluateAndApply(this, ContentCategory.StageDirection)));
        const stageDirections = this.content;

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

        // await this.messenger.updateEnvironment({input_enabled: false});
        this.replacements = {'user': this.user.name, 'char': (this.characters[anonymizedId] ? this.characters[anonymizedId].name : '')};

        console.log('Process pre-response variables');
        await this.processVariablesPreResponse();

        console.log('Handle generators and classifiers');
        this.resetGeneratorsAndClassifiers()
        this.setContent(content);
        this.buildScope(); // Make content available to dynamic label functions
        while (!this.processRequests(GeneratorPhase.OnResponse)) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        await this.processVariablesPostResponse();
        this.buildScope();

        Object.values(this.contentRules).forEach(contentRule => this.setContent(contentRule.evaluateAndApply(this, ContentCategory.Response)));
        const modifiedMessage = this.content;

        this.setContent('');
        this.buildScope();
        Object.values(this.contentRules).forEach(contentRule => this.setContent(contentRule.evaluateAndApply(this, ContentCategory.PostResponse)));
        const systemMessage = this.content;

        // await this.messenger.updateEnvironment({input_enabled: true});
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
        this.scope['content'] = this.content;
        return this.scope;
    }

    setContent(content: string) {
        this.content = content;
        this.buildScope();
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
