export class VariableDefinition {
    name: string;
    type: string;
    initialValue: any;
    defaultUpdate: any;
    source: string;
    classificationPrompt: string;
    classificationThreshold: number;
    classificationMap: {[key: string]: any};

    constructor(data: any) {
        this.name = data.name;
        this.type = data.type;
        this.initialValue = data.initialValue;
        this.defaultUpdate = data.defaultUpdate;
        this.source = data.source;
        this.classificationPrompt = data.classificationPrompt;
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