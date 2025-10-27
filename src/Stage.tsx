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
    users: {[key: string]: User};
    lastUserId: string = '';
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
        console.log(this.characters);
        this.users = users;
        this.updateReplacements(Object.keys(this.users)[0], Object.keys(this.characters)[0]);
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
        console.log('Statosphere constructed');
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
        const builtInFunctions = {
            split: new CustomFunction({name: 'split', parameters: 'haystack, needle', body: `\
                        return haystack.split(needle);`
            }, this),
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
                        const flagMatch = regexString.match(/\\/([a-z]*)$/i);
                        const flags = flagMatch ? flagMatch[1] : 'g';
                        const cleanRegex = regexString.replace(/\\/[a-z]*$/i, '');
                        return input.replace(new RegExp(cleanRegex, flags), newValue);`
            }, this),
            join: new CustomFunction({name: 'join', parameters: 'arrayToJoin, separator', body: `\
                        if (arrayToJoin) {
                            return arrayToJoin.join(separator);
                        } else {
                            return '';
                        }`
            }, this),
            substring: new CustomFunction({
                name: 'substring', parameters: 'input, start, end', body: `\
                        if (input) {
                          return input.substring(start, end);
                        }
                        return null;`
            }, this),
            isNull: new CustomFunction({
                name: 'isNull', parameters: 'input', body: `\
                        return input === null || input === undefined;`
            }, this),
            isNotNull: new CustomFunction({
                name: 'isNotNull', parameters: 'input', body: `\
                        return input !== null && input !== undefined;`
            }, this)
        };
        this.functions = {...builtInFunctions}

        // Load additional functions
        Object.values(this.validateSchema(functionJson, functionSchema, 'function schema'))
            .forEach(funcData => {
                let customFunction = new CustomFunction(funcData, this);
                this.functions[customFunction.name] = customFunction;
            });
        // Update based on dependencies:
        Object.values(this.functions).forEach(thisFunction => {
            if (!builtInFunctions.hasOwnProperty(thisFunction.name)) {
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
            }
        });
        // All dependencies updated; now persist arguments to calls:
        Object.values(this.functions).forEach(thisFunction => {
            if (!builtInFunctions.hasOwnProperty(thisFunction.name)) {
                thisFunction.body = this.updateFunctionArguments(thisFunction.body);
            }
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
        console.log('Initialize variables.');
        for (const definition of variableDefinitions) {
            try {
                this.variableDefinitions[definition.name] = new VariableDefinition(definition, this);
                if (!this.variables[definition.name]) {
                    this.initializeVariable(definition.name);
                }
            } catch(error) {
                console.log(error);
                console.log('Encountered the above error while creating variable:');
                console.log(definition);
            }
        }

        console.log('Validate generators.');
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

        console.log('Validate content modifiers.');
        Object.values(this.validateSchema(contentJson, contentSchema, 'content schema'))
            .forEach(contentRule => this.contentRules.push(new ContentRule(contentRule, this)));

        console.log('Validate classifiers.');
        Object.values(this.validateSchema(classifierJson, classifierSchema, 'classifier schema'))
            .forEach(classifierData => {const classifier = new Classifier(classifierData, this);this.classifiers[classifier.name] = classifier;});

        if (Object.values(this.classifiers).length > 0) {
            console.log('Load classifier pipeline.');
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

            console.log('Load backend client.');
            this.client = await Client.connect("Ravenok/statosphere-backend");
            console.log('Loaded client.');
        } else {
            console.log('No classifiers');
        }

        if (this.variables['debugMode']) {
            console.log('Debug mode enabled.');
            this.debugMode = true;
        }
        this.buildScope();
        await this.checkBackground();

        console.log('Finished loading Statosphere.');
        return {
            success: true,
            error: `Caution: This bot is using <a href="https://chub.ai/extensions/Ravenok/statosphere-3704059fdd7e">Statosphere</a>, a stage that can implement a variety of effects that extend beyond the bot's definition.`,
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

    async checkBackground() {
        if (this.background != this.scope.background ?? '') {
            console.log(`Background changing from ${this.background} to ${this.scope.background}`);
            await this.messenger.updateEnvironment({background: this.scope.background ?? ''});
            this.background = this.scope.background;
        }
    }

    async setState(state: MessageStateType): Promise<void> {
        this.readMessageState(state);
        this.buildScope();
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
            generator.retries = 0;
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

    processRequests(phase: GeneratorPhase, char: Character, user: User): boolean {
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
                    //console.log(`Classification ${classification.label} selected with score ${categoryScores[key]}`);
                    for (let variable of Object.keys(classification.updates)) {
                        //console.log(`Classification ${classification.label} is updating ${variable}`);
                        this.replacements['label'] = specificLabels[key];
                        this.updateVariable(variable, classification.updates[variable]);
                    }
                }
                classifier.processed = true;
            } else {
                finished = false;
                if (!classifier.isStarted()) {
                    this.kickOffClassifier(classifier, phase, char, user);
                }
            }
        }

        for (const generator of Object.values(this.generators).filter(generator => !generator.isDone())) {
            if (generator.isReady()) {
                this.applyGeneratorResponse(generator, phase, generator.result);
                if (!generator.processed) {
                    finished = false;
                }
            } else {
                finished = false;
                if (!generator.isStarted()) {
                    this.kickOffGenerator(generator, phase);
                }
            }
        }

        return finished;
    }

    kickOffClassifier(classifier: Classifier, phase: GeneratorPhase, char: Character, user: User) {
        try {
            // If there are no dependencies that haven't completed, then this classifier can start.
            if (classifier.dependencies.filter(dependency => !((this.generators[dependency] ? this.generators[dependency].isDone() : true) && (this.classifiers[dependency] ? this.classifiers[dependency].isDone() : true))).length == 0) {
                let sequenceTemplate = this.replaceTags((phase == GeneratorPhase.OnInput ? classifier.inputTemplate : classifier.responseTemplate) ?? '');
                sequenceTemplate = sequenceTemplate.trim() == '' ? this.content : sequenceTemplate.replace('{}', this.content);
                let hypothesisTemplate = this.replaceTags((phase == GeneratorPhase.OnInput ? classifier.inputHypothesis : classifier.responseHypothesis) ?? '');
                // No hypothesis (this classifier doesn't apply to this contentSource) or condition set but not true):
                if (hypothesisTemplate.trim() == '' || !this.evaluate(this.replaceTags(classifier.condition), this.scope)) {
                    classifier.skipped = true;
                } else {
                    let candidateLabels: string[] = [];
                    let thisLabelMapping: { [key: string]: string } = {};
                    for (const label of Object.keys(classifier.classifications)) {
                        if (!this.evaluate(this.replaceTags(classifier.classifications[label].condition), this.scope)) {
                            continue;
                        }
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

                    const input = {
                        sequence: sequenceTemplate,
                        candidate_labels: candidateLabels,
                        hypothesis_template: hypothesisTemplate,
                        multi_label: true
                    };
                    const promise = classifier.useLlm ? this.queryLlm(input, char, user, classifier.useHistory) : this.queryHf(input);
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
                    if (generator.type == GeneratorType.Text) {
                        const prompt = this.evaluate(this.replaceTags(generator.prompt), this.scope);
                        console.log('Kicking off a text generator with prompt:\n' + prompt);
                        promise = this.generator.textGen({
                            prompt: prompt,
                            min_tokens: generator.minTokens,
                            max_tokens: generator.maxTokens,
                            stop: generator.stoppingStrings.split(','),
                            include_history: generator.includeHistory
                        })
                    } else if (generator.type == GeneratorType.Image) {
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
                        const negativePrompt = this.evaluate(this.replaceTags(generator.negativePrompt), this.scope);
                        console.log('Kicking off an image-to-image generator with prompt:\n' + prompt);
                        promise = this.generator.imageToImage({
                            image: this.evaluate(this.replaceTags(generator.sourceImageUrl), this.scope),
                            prompt: prompt,
                            negative_prompt: negativePrompt,
                            transfer_type: generator.imageToImageType,
                            remove_background: generator.removeBackground
                        });
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

    applyGeneratorResponse(generator: Generator, generatorPhase: GeneratorPhase, response: TextResponse | ImagineResponse | null) {
        const result = response ? ('result' in response ? response.result : response.url) : '';
        console.log(`Received response for generator ${generator.name}:\n${result}`);
        const backupContent = this.content;
        this.setContent(result);

        if (result == '' || this.evaluate(this.replaceTags(generator.retryCondition ?? 'false'), this.buildScope())) {
            // Retry the request:
            if (++generator.retries < 3) {
                console.log(`Retrying generator ${generator.name}.`);
                generator.result = undefined;
                this.kickOffGenerator(generator, generatorPhase);
            } else {
                console.log(`Generator ${generator.name} exhausted retries; skipping.`);
                generator.skipped = true;
            }
        } else {
            for (let variable of Object.keys(generator.updates)) {
                this.updateVariable(variable, generator.updates[variable]);
            }
            this.setContent(backupContent);
            generator.processed = true;
        }
    }

    updateReplacements(userId: string|null, charId: string|null) {
        if (userId) {
            this.lastUserId = userId;
        }
        this.replacements = {
            'user': (this.users[this.lastUserId ?? '']?.name ?? '').replace(/"/g, '\\"'),
            'persona': (this.users[this.lastUserId ?? '']?.chatProfile ?? '').replace(/"/g, '\\"'),
            'char': (this.characters[charId ?? '']?.name ?? '').replace(/"/g, '\\"'),
            'personality': (this.characters[charId ?? '']?.personality ?? '').replace(/"/g, '\\"'),
            'scenario': (this.characters[charId ?? '']?.scenario ?? '').replace(/"/g, '\\"'),
        };
    }

     replaceTags(source: string) {

        if (!source) return '';
        let replacements = this.replacements;
        for (const key of Object.keys(this.variables)) {
            let value = this.getVariable(key);
            if (typeof this.getVariable(key) in ['object','string']) {
                value = JSON.stringify(value);
            }
            replacements[key.toLowerCase()] = String(value).replace(/"/g, '\\"');
        }
        replacements['content'] = this.content ? this.content.replace(/"/g, '\\"') : this.content;
        return source.replace(/{{([A-z]*)}}/g, (match) => {
            const variableName = match.substring(2, match.length - 2).toLowerCase()
            return (variableName in replacements ? replacements[variableName] : match);
        });
    }

    /* Original
     replaceTags(source: string) {

        if (!source) return '';
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
     */

    async queryLlm(data: any, char: Character, user: User, useHistory: boolean = false) {
        // This version builds a prompt and sends it to the text generation endpoint, then parses the response to determine label scoring.
        let result: any = null;
        let tries = 3;
        // Use generator.textGen to query the LLM. Don't care about the client here.
        while (tries > 0 && (!result || result.labels.length == 0)) {
            tries--;
            try {
                let prompt = `{{system_prompt}}\n\n` +
                    (char ? `About {{char}}:\n${char.description} ${char.personality}\n\n` : '') +
                    (user ? `About {{user}}:\n${user.chatProfile}\n\n` : '') +
                    (useHistory ? `Conversation history:\n{{messages}}\n\n` : '') +
                    `Passage for Analysis: ${data.sequence}\n\n` +
                    `Hypothesis Statements: \n${[...data.candidate_labels].map(candidate => data.hypothesis_template.replace('{}', candidate)).join('\n')}.\n\n` +
                    `Current Task: Within the context of this narrative, analyze the above passage, then rank and score the entailment of each hypothesis statement with regards to the passage on a scale of 0.0000 to 1.0000. ` +
                    `Output each hypothesis verbatim, followed by its entailment score in this sample format: \n` +
                    `1. Inarguably supported hypothesis statement: 1.0\n` +
                    `2. Likely supported hypothesis statement: 0.7\n` +
                    `3. Vaguely supported hypothesis statement: 0.3\n` +
                    `4. Unsupported hypothesis statement: 0.0\n` +
                    `###\n` +
                    `General Instruction: \n`;
                console.log('LLM classification prompt:\n' + prompt);
                const response = await this.generator.textGen({
                    prompt: prompt,
                    min_tokens: 1,
                    max_tokens: 1000,
                    include_history: useHistory,
                    stop: ['###', '\n\n']
                });
                const textResponse = response as TextResponse;
                console.log('LLM classification response:\n' + textResponse.result);
                // Parse the response to determine which labels were mentioned.
                let foundLabels: string[] = [];
                let foundScores: number[] = [];
                const lines = textResponse.result.split('\n');
                for (let line of lines) {
                    const match = line.match(/^\s*\d+\.\s*(.*?):\s*([0-9]*\.?[0-9]+)/);
                    if (match) {
                        const label = match[1].trim();
                        const score = parseFloat(match[2]);
                        let bestMatch = null;
                        let bestScore = 0;
                        for (let candidate of data.candidate_labels) {
                            // Jaccard similarity between label and candidate:
                            const finalCandidate = data.hypothesis_template.replace('{}', candidate);
                            const labelSet = new Set(label.toLowerCase().trim().split(' '));
                            const candidateSet = new Set(finalCandidate.toLowerCase().trim().split(' '));
                            const intersection = new Set([...labelSet].filter(x => candidateSet.has(x)));
                            const union = new Set([...labelSet, ...candidateSet]);
                            const matchScore = intersection.size / union.size;
                            // Also consider direct substring matches:
                            if (matchScore > bestScore) {
                                bestScore = matchScore;
                                bestMatch = candidate;
                            }
                        }
                        if (bestScore >= 0.5 && !foundLabels.includes(bestMatch)) {
                            foundLabels.push(bestMatch);
                            foundScores.push(score);
                        }
                    }
                }

                result = {labels: foundLabels, scores: foundScores};
                console.log(result);
            } catch (e) {
                console.log(e);
            }
        }
        return result;
    }

    async queryHf(data: any) {
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
            Client.connect("Ravenok/statosphere-backend").then(client => {this.fallbackMode = false; this.client = client}).catch(err => console.log(err));

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
            anonymizedId,
            content,
            promptForId
        } = userMessage;
        console.log('Start beforePrompt().');

        // Check for /setVar in this message, which allows the user to update a variable directly.
        // Format is /setVar variableName=value
        // Where value extends to newline or end of message.
        // There can be multiple matches; loop through and process all of them
        let updatedContent = content;
        const setVarRegex = /\/setvar\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n\r]+)/gi;
        let match;
        while ((match = setVarRegex.exec(content)) !== null) {
            const varName = match[1];
            const varValue = match[2];
            if (this.variableDefinitions[varName]) {
                console.log(`Attempting to set variable ${varName} to ${varValue}`);
                this.updateVariable(varName, varValue);
            } else {
                console.warn(`Attempted to set an unknown variable: ${varName}`);
            }
            // Clean up setvar from content:
            updatedContent = updatedContent.replace(match[0], '').trim();
        }

        this.updateReplacements(anonymizedId, promptForId);

        console.log('Process initial input variable changes.');
        await this.processVariablesPreInput();

        console.log('Handle input generators and classifiers.');
        this.resetGeneratorsAndClassifiers()
        this.setContent(`${updatedContent}`);
        this.buildScope();
        while (!this.processRequests(GeneratorPhase.OnInput, this.characters[promptForId ?? ''] ?? null, this.users[anonymizedId ?? ''] ?? null)) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log('Process final input variable changes.')
        await this.processVariablesPostInput();

        console.log('Apply input content rules.');
        this.setContent(`${updatedContent}`);
        Object.values(this.contentRules).forEach(contentRule => this.setContent(contentRule.evaluateAndApply(this, ContentCategory.Input)));
        const modifiedMessage = this.content.trim() == '' ? '\n' : this.replaceTags(this.content);


        this.setContent('');
        Object.values(this.contentRules).forEach(contentRule => this.setContent(contentRule.evaluateAndApply(this, ContentCategory.PostInput)));
        const systemMessage = this.content;


        this.setContent('');
        Object.values(this.contentRules).forEach(contentRule => this.setContent(contentRule.evaluateAndApply(this, ContentCategory.StageDirection)));
        const stageDirections = this.content;

        console.log('End beforePrompt().');
        return {
            stageDirections: stageDirections.trim() != '' ? `Response Instruction: ${stageDirections}` : null,
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
        console.log('Start afterResponse().');

        // await this.messenger.updateEnvironment({input_enabled: false});
        this.updateReplacements(null, anonymizedId);

        console.log('Process initial response variable changes.');
        await this.processVariablesPreResponse();

        console.log('Handle response generators and classifiers.');
        this.resetGeneratorsAndClassifiers()
        this.setContent(content);
        this.buildScope(); // Make content available to dynamic label functions
        while (!this.processRequests(GeneratorPhase.OnResponse, this.characters[anonymizedId ?? ''] ?? null, this.users[this.lastUserId ?? ''] ?? null)) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log('Process final response variable changes.');
        await this.processVariablesPostResponse();
        this.buildScope();

        console.log('Apply response content rules.');
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
        return <></>
    }

}
