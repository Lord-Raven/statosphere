export class VariableDefinition {
    name: string;
    type: string;
    initialValue: any;
    defaultUpdate: any;
    source: string;
    assessmentPrompt: string;
    assessmentThreshold: number;
    assessmentMap: {[key: string]: any};

    constructor(data: any) {
        this.name = data.name;
        this.type = data.type;
        this.initialValue = data.initialValue;
        this.defaultUpdate = data.defaultUpdate;
        this.source = data.source;
        this.assessmentPrompt = data.assessmentPrompt;
        this.assessmentThreshold = data.assessmentThreshold ?? 0.5;
        this.assessmentMap = data.assessmentMap;
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