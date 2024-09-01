import {stripComments} from "./Stage";

export class CustomFunction {
    name: string;
    parameters: string;
    dependencies: string = '';
    body: string;

    constructor(data: any) {
        this.name = stripComments(data.name);
        this.parameters = stripComments(data.parameters);
        this.body = stripComments(data.body);
    }

    // Method to create the function dynamically
    createFunction() {
        let finalParameters = [...(this.parameters ? this.parameters.split(',').filter(item => item).map(item => item.trim()) : []),
            ...(this.dependencies ? this.dependencies.split(',').filter(item => item).map(item => `${item.trim()}=${item.trim()}`) : [])];

        if (finalParameters.length > 0) {
            return new Function(...finalParameters, this.body);
        } else {
            return new Function('', this.body);
        }
    }
}