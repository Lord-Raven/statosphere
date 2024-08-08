export class VariableDefinition {
    name: string;
    type: string;
    initialValue: any;
    defaultUpdate: any;
    inputHypothesis: string;
    responseHypothesis: string;
    classificationThreshold: number;
    classificationMap: {[key: string]: any};

    constructor(data: any) {
        this.name = data.name;
        this.type = data.type;
        this.initialValue = data.initialValue;
        this.defaultUpdate = data.defaultUpdate;
        this.inputHypothesis = data.inputHypothesis;
        this.responseHypothesis = data.responseHypothesis;
        this.classificationThreshold = data.classificationThreshold ?? 0.5;
        this.classificationMap = data.classificationMap;
    }
}

export class Variable {
    definitionName: string;
    value: any;

    constructor(definitionName: any, variableDefinitions: {[key: string]: VariableDefinition}) {
        this.definitionName = definitionName;
        this.value = variableDefinitions[definitionName].initialValue;
    }
}