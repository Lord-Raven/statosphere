import {Stage} from "./Stage";

export class VariableDefinition {
    name: string;
    initialValue: any;
    perTurnUpdate: any;
    postInputUpdate: any;
    postResponseUpdate: any;
    constant: boolean;

    constructor(data: any, stage: Stage) {
        this.name = stage.processCode(data.name);
        this.initialValue = stage.processCode(data.initialValue);
        this.perTurnUpdate = stage.processCode(data.perTurnUpdate);
        this.postInputUpdate = stage.processCode(data.postInputUpdate);
        this.postResponseUpdate = stage.processCode(data.postResponseUpdate);
        this.constant = !this.perTurnUpdate && !this.postInputUpdate && !this.postResponseUpdate;
    }
}

export class Variable {
    definitionName: string;
    value: any;

    constructor(definitionName: any, variableDefinitions: {[key: string]: VariableDefinition}, stage: Stage) {
        this.definitionName = definitionName;
        console.log(variableDefinitions[definitionName].initialValue);
        this.value = stage.evaluate(stage.replaceTags(`(${variableDefinitions[definitionName].initialValue})`, {}));
        console.log(this.value);
    }
}