import {stripComments} from "./Stage";

export class CustomFunction {
    name: string;
    parameters: string;
    body: string;

    constructor(data: any) {
        this.name = stripComments(data.name);
        this.parameters = data.parameters;
        this.body = stripComments(data.body);
    }

    // Method to create the function dynamically
    createFunction() {
        const params = this.parameters;
        const functionBody = `return (${this.body});`;
        return new Function(params, functionBody);
    }
}