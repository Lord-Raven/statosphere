import {Stage} from "./Stage";

export class Classifier {
    name: string;
    condition: string;
    inputTemplate: any;
    responseTemplate: any;
    inputHypothesis: any;
    responseHypothesis: any;
    dependencies: string[];
    classifications: {[key: string]: Classification};
    useLlm: boolean;
    useHistory: boolean;
    historyContextSize: number;

    skipped: boolean = false;
    processed: boolean = false;
    promise: any = null;
    result: any = undefined;


    constructor(data: any, stage: Stage) {
        this.name = stage.processCode(data.name);
        this.condition = stage.processCode(data.condition);
        if (!this.condition || this.condition.trim().length == 0) this.condition = 'true';
        this.inputTemplate = stage.processCode(data.inputTemplate);
        this.responseTemplate = stage.processCode(data.responseTemplate);
        this.inputHypothesis = stage.processCode(data.inputHypothesis);
        this.responseHypothesis = stage.processCode(data.responseHypothesis);
        this.dependencies = data.dependencies ? data.dependencies.toString().split(',').map((dependency: string) => dependency.trim()) : [];
        this.classifications = {};
        this.useLlm = data.useLlm ?? false;
        this.useHistory = data.useHistory ?? false;
        this.historyContextSize = data.historyContextSize ?? 0;
        for (let classification of data.classifications) {
            this.classifications[classification.label] = new Classification(classification, stage);
        }
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

export class Classification {
    label: string;
    condition: string;
    category: string;
    threshold: number;
    dynamic: boolean;
    updates: {[key: string]: string};

    constructor(data: any, stage: Stage) {
        this.label = stage.processCode(data.label);
        this.condition = stage.processCode(data.condition);
        if (!this.condition || this.condition.trim().length == 0) this.condition = 'true';
        this.category = stage.processCode(data.category);
        this.threshold = data.threshold;
        this.dynamic = data.dynamic ?? false;
        this.updates = {};
        const updates: any[] = data.updates;
        Object.values(updates).forEach(update => this.updates[update.variable] = stage.processCode(update.setTo));
    }
}