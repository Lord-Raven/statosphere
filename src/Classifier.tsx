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

    constructor(data: any, stage: Stage) {
        this.name = stage.processCode(data.name);
        this.condition = stage.processCode(data.condition);
        this.inputTemplate = stage.processCode(data.inputTemplate);
        this.responseTemplate = stage.processCode(data.responseTemplate);
        this.inputHypothesis = stage.processCode(data.inputHypothesis);
        this.responseHypothesis = stage.processCode(data.responseHypothesis);
        this.dependencies = data.dependencies?.split(',') ?? [];
        this.classifications = {};
        for (let classification of data.classifications) {
            this.classifications[classification.label] = new Classification(classification, stage);
        }
    }
}

export class Classification {
    label: string;
    category: string;
    threshold: number;
    dynamic: boolean;
    updates: {[key: string]: string};

    constructor(data: any, stage: Stage) {
        this.label = stage.processCode(data.label);
        this.category = stage.processCode(data.category);
        this.threshold = data.threshold;
        this.dynamic = data.dynamic ?? false;
        this.updates = {};
        const updates: any[] = data.updates;
        Object.values(updates).forEach(update => this.updates[update.variable] = stage.processCode(update.setTo));
    }
}