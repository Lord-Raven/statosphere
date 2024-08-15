export class VariableDefinition {
    name: string;
    initialValue: any;
    perTurnUpdate: any;
    postInputUpdate: any;
    postResponseUpdate: any;

    constructor(data: any) {
        this.name = data.name;
        this.initialValue = data.initialValue;
        this.perTurnUpdate = data.perTurnUpdate;
        this.postInputUpdate = data.postInputUpdate;
        this.postResponseUpdate = data.postResponseUpdate;
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