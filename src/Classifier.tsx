export class Classifier {
    name: string;
    inputHypothesis: any;
    responseHypothesis: any;
    classifications: {[key: string]: Classification};

    constructor(data: any) {
        console.log('Loading classifier');
        this.name = data.name;
        this.inputHypothesis = data.inputHypothesis;
        this.responseHypothesis = data.responseHypothesis
        this.classifications = {};
        for (let classification of data.classifications) {
            this.classifications[classification.label] = new Classification(data);
        }
    }
}

export class Classification {
    label: string;
    category: string;
    threshold: number;
    updates: {[key: string]: string}

    constructor(data: any) {
        console.log(`Loading classification: ${data.threshold}`);
        this.label = data.label;
        this.category = data.category;
        this.threshold = data.threshold;
        this.updates = data.updates;
    }
}