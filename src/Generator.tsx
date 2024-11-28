import {Stage} from "./Stage";
import {AspectRatio, ImagineResponse, TextResponse} from "@chub-ai/stages-ts";

export enum GeneratorPhase {
    Initialization = 'Initialization',
    OnInput = 'On Input',
    OnResponse = 'On Response'
}

export enum GeneratorType {
    Text = 'Text',
    Image = 'Image'
}

export class Generator {
    name: any;
    type: GeneratorType;
    phase: GeneratorPhase;
    lazy: boolean;
    condition: any;
    prompt: any;
    negativePrompt: any;
    template: any;
    includeHistory: boolean;
    minTokens: any;
    maxTokens: any;
    aspectRatio: any;
    removeBackground: boolean;
    updates: {[key: string]: string}
    dependencies: string[];

    constructor(data: any, stage: Stage) {

        let someString: string;

        this.name = data.name;
        this.type = data.type;
        this.phase = data.phase;
        this.lazy = data.lazy ?? false;
        this.condition = stage.processCode(data.condition);
        this.prompt = stage.processCode(data.prompt);
        this.negativePrompt = stage.processCode(data.negativePrompt);
        this.template = stage.processCode(data.template);
        this.includeHistory = data.includeHistory ?? false;
        this.minTokens = data.minSize;
        this.maxTokens = data.maxSize;
        this.aspectRatio = data.aspectRatio ?? AspectRatio.PHOTO_HORIZONTAL;
        this.removeBackground = data.removeBackground ?? false;
        this.dependencies = data.dependencies?.split(',') ?? [];
        this.updates = {};
        const updates: any[] = data.updates;
        Object.values(updates).forEach(update => this.updates[update.variable] = stage.processCode(update.setTo));
    }
}

export class GeneratorPromise {
    complete = false;
    generatorName: string;
    promise: Promise<TextResponse | ImagineResponse | null>;
    response: TextResponse | ImagineResponse | null;

    constructor(generatorName: string, promise: Promise<TextResponse | ImagineResponse | null>) {
        this.generatorName = generatorName;
        this.promise = promise;
        this.response = {result: ''};
        this.promise.then(
            (response) => {
                this.response = response;
                this.complete = true;
            },
            () => {
                this.complete = true;
            });
    }
}