import {Stage} from "./Stage";

export class CustomFunction {
    name: string;
    parameters: string;
    dependencies: string = '';
    body: string;

    constructor(data: any, stage: Stage) {
        this.name = stage.stripComments(data.name);
        this.parameters = stage.stripComments(data.parameters);
        this.body = stage.stripComments(data.body);
    }

    // Method to create the function dynamically
    createFunction() {
        let finalParameters = [...(this.parameters ? this.parameters.split(',').filter(item => item).map(item => item.trim()) : []),
            ...(this.dependencies ? this.dependencies.split(',').filter(item => item).map(item => item.trim()) : [])];

        console.log('Creating function');
        console.log(finalParameters);
        console.log(this.body);
        if (finalParameters.length > 0) {
            return new Function(...finalParameters, this.body);
        } else {
            return new Function('', this.body);
        }
    }
}