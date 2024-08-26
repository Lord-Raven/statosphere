import {stripComments} from "./Stage";

export class Classifier {
    name: string;
    inputTemplate: any;
    responseTemplate: any;
    inputHypothesis: any;
    responseHypothesis: any;
    classifications: {[key: string]: Classification};

    constructor(data: any) {
        this.name = stripComments(data.name);
        this.inputTemplate = stripComments(data.inputTemplate);
        this.responseTemplate = stripComments(data.responseTemplate);
        this.inputHypothesis = stripComments(data.inputHypothesis);
        this.responseHypothesis = stripComments(data.responseHypothesis);
        this.classifications = {};
        for (let classification of data.classifications) {
            this.classifications[classification.label] = new Classification(classification);
        }
    }
}

export class Classification {
    label: string;
    category: string;
    threshold: number;
    updates: {[key: string]: string}

    constructor(data: any) {
        this.label = stripComments(data.label);
        this.category = stripComments(data.category);
        this.threshold = data.threshold;
        this.updates = {};
        const updates: any[] = data.updates;
        Object.values(updates).forEach(update => this.updates[update.variable] = stripComments(update.setTo));
    }
}