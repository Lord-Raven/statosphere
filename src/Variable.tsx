export class VariableDefinition {
    name: string;
    initialValue: any;
    perTurnUpdate: any;

    constructor(data: any) {
        console.log('Loading variable definition');
        this.name = data.name;
        this.initialValue = data.initialValue;
        this.perTurnUpdate = data.perTurnUpdate;
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