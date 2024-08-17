import {Parser} from "expr-eval";
import {Stage} from "./Stage";

export class PromptRule {
    condition: string
    prompt: string
    subRules: PromptRule[]

    constructor(data: any) {
        this.condition = data.condition;
        this.prompt = data.prompt ?? '';
        this.subRules = data.subRules ?? [];
    }

    evaluate(stage: Stage): string {
        if (this.prompt.trim() != '') {
            console.log(this.condition);
            return (stage.parser.evaluate(stage.replaceTags(this.condition.toLowerCase(), {})) ? this.prompt : '');
        } else if (this.subRules.length > 0) {
            return (Object.values(this.subRules).map(rule => rule.evaluate(stage)).filter(retVal => retVal.trim().length > 0).join('\n'))
        }
        return '';
    }
}