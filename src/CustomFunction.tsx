import {stripComments} from "./Stage";

export class CustomFunction {
    name: string;
    parameters: string;
    body: string;

    constructor(data: any) {
        this.name = stripComments(data.name);
        this.parameters = stripComments(data.parameters);
        this.body = stripComments(data.body);
    }

    // Method to create the function dynamically
    createFunction() {
        if (this.parameters && this.parameters.trim().length > 0) {
            return new Function(...this.parameters.split(','), this.body);
        } else {
            return new Function(this.body);
        }
    }
}