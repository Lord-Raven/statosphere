import {Stage} from "./Stage";
import {AspectRatio} from "@chub-ai/stages-ts";

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
    retryCondition: any;
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

    retries: number = 0;
    skipped: boolean = false;
    processed: boolean = false;
    promise: any = null;
    result: any = undefined;

    constructor(data: any, stage: Stage) {

        this.name = data.name;
        this.type = data.type;
        this.phase = data.phase;
        this.lazy = data.lazy ?? false;
        this.condition = stage.processCode(data.condition);
        if (!this.condition || this.condition.trim().length == 0) this.condition = 'true';
        this.retryCondition = stage.processCode(data.retryCondition);
        if (!this.retryCondition || this.retryCondition.trim().length == 0) this.retryCondition = 'false';
        this.prompt = stage.processCode(data.prompt);
        this.negativePrompt = stage.processCode(data.negativePrompt);
        this.template = stage.processCode(data.template);
        this.includeHistory = data.includeHistory ?? false;
        this.minTokens = data.minTokens;
        this.maxTokens = data.maxTokens;
        this.aspectRatio = data.aspectRatio ?? AspectRatio.PHOTO_HORIZONTAL;
        this.removeBackground = data.removeBackground ?? false;
        this.dependencies = data.dependencies ? data.dependencies.toString().split(',').map((dependency: string) => dependency.trim()) : [];
        this.updates = {};
        const updates: any[] = data.updates;
        Object.values(updates).forEach(update => this.updates[update.variable] = stage.processCode(update.setTo));
        const lastQuote = this.prompt.lastIndexOf('"');
        if (this.includeHistory && !this.prompt.includes("{{post_history_instructions}}") && lastQuote >= 0) {
            const beforeQuote = this.prompt.substring(0, lastQuote);
            const afterQuote = this.prompt.substring(lastQuote);
            this.prompt = `${beforeQuote}\n{{post_history_instructions}}${afterQuote}`;
        }
        console.log('Loaded this generator:');
        console.log(this);
    }

    isReady(): boolean {
        return this.result != undefined && !this.processed && !this.skipped;
    }

    isDone(): boolean {
        return this.skipped || this.processed;
    }

    isStarted(): boolean {
        return this.skipped || this.promise;
    }

}