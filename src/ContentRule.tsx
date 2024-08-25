import {Stage} from "./Stage";

export enum ContentCategory {
    Input = 'Input',
    Response = 'Response',
    SystemMessage = 'System Message',
    StageDirection = 'Stage Direction'
}

export class ContentRule {
    category: ContentCategory;
    condition: string;
    modification: string;

    constructor(data: any) {
        this.category = data.category;
        this.condition = data.condition;
        this.modification = data.modification ?? '{{content}}';
    }

    evaluateAndApply(stage: Stage, targetCategory: ContentCategory, replacements: any): string {
        if (this.category == targetCategory && stage.evaluate(stage.replaceTags(this.condition.toLowerCase(), replacements))) {
            console.log(this.modification);
            console.log(replacements);
            return stage.evaluate(stage.replaceTags(this.modification, replacements));
        }
        return stage.content;
    }
}