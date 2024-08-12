import {Parser} from "expr-eval";

export class PromptRule {
    condition: string
    prompt: string
    subRules: PromptRule[]

    constructor(data: any) {
        console.log(`building rule: ${data.condition}`);
        this.condition = data.condition;
        this.prompt = data.prompt ?? '';
        this.subRules = data.subRules ?? [];
    }

    evaluate(replace: (input: string, other: {[key: string]: string}) => string): string {
        if (this.prompt.trim() != '') {
            return (Parser.evaluate(replace(this.condition, {})) ? this.prompt : '');
        } else if (this.subRules.length > 0) {
            return (Object.values(this.subRules).map(rule => rule.evaluate(replace)).filter(retVal => retVal.trim().length > 0).join('\n'))
        }
        return '';
    }
}