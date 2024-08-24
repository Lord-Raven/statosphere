export class Classifier {
    name: string;
    inputTemplate: any;
    responseTemplate: any;
    inputHypothesis: any;
    responseHypothesis: any;
    classifications: {[key: string]: Classification};

    constructor(data: any) {
        this.name = data.name;
        this.inputTemplate = data.inputTemplate;
        this.responseTemplate = data.responseTemplate;
        this.inputHypothesis = data.inputHypothesis;
        this.responseHypothesis = data.responseHypothesis;
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
        this.label = data.label;
        this.category = data.category;
        console.log('threshold:' + data.threshold);
        this.threshold = data.threshold;
        this.updates = {};
        const updates: any[] = data.updates;
        Object.values(updates).forEach(update => this.updates[update.variable] = update.setTo);
    }
}