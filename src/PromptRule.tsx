import {Parser} from "expr-eval";

export class PromptRule {
    rule: string
    prompt: string
    subRules: PromptRule[]

    constructor(data: any) {
        this.rule = data.rule;
        this.prompt = data.prompt ?? '';
        this.subRules = data.subRules ?? [];
    }

    evaluate(replace: (input: string, other: any) => string): string {
        if (this.prompt.trim() != '') {
            return (Parser.evaluate(replace(this.rule, {})) ? this.prompt : '');
        } else if (this.subRules.length > 0) {
            return (Object.values(this.subRules).map(rule => rule.evaluate(replace)).filter(retVal => retVal.trim().length > 0).join('\n'))
        }
        return '';
    }
}