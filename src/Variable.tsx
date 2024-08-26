import {stripComments} from "./Stage";

export class VariableDefinition {
    name: string;
    initialValue: any;
    perTurnUpdate: any;
    postInputUpdate: any;
    postResponseUpdate: any;
    constant: boolean;

    constructor(data: any) {
        this.name = stripComments(data.name);
        this.initialValue = stripComments(data.initialValue);
        this.perTurnUpdate = stripComments(data.perTurnUpdate);
        this.postInputUpdate = stripComments(data.postInputUpdate);
        this.postResponseUpdate = stripComments(data.postResponseUpdate);
        this.constant = !this.perTurnUpdate && !this.postInputUpdate && !this.postResponseUpdate;
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