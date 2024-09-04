import {Stage} from "./Stage";

export class Classifier {
    name: string;
    inputTemplate: any;
    responseTemplate: any;
    inputHypothesis: any;
    responseHypothesis: any;
    classifications: {[key: string]: Classification};

    constructor(data: any, stage: Stage) {
        this.name = stage.processCode(data.name);
        this.inputTemplate = stage.processCode(data.inputTemplate);
        this.responseTemplate = stage.processCode(data.responseTemplate);
        this.inputHypothesis = stage.processCode(data.inputHypothesis);
        this.responseHypothesis = stage.processCode(data.responseHypothesis);
        this.classifications = {};
        for (let classification of data.classifications) {
            this.classifications[classification.label] = new Classification(classification, stage);
        }
        new RegExp(`\[.+?\]\(https?:\/\/[^\s]+(?:\s+'([^"]+)")?\)`)
    }
}

export class Classification {
    label: string;
    category: string;
    threshold: number;
    updates: {[key: string]: string}

    constructor(data: any, stage: Stage) {
        this.label = stage.processCode(data.label);
        this.category = stage.processCode(data.category);
        this.threshold = data.threshold;
        this.updates = {};
        const updates: any[] = data.updates;
        Object.values(updates).forEach(update => this.updates[update.variable] = stage.processCode(update.setTo));
    }
}