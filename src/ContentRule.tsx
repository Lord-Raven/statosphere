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

    constructor(data: any, stage: Stage) {
        this.category = data.category;
        this.condition = stage.processCode(data.condition);
        this.modification = stage.processCode(data.modification ?? '{{content}}');
    }

    evaluateAndApply(stage: Stage, targetCategory: ContentCategory, replacements: any): string {
        if (this.category == targetCategory && stage.evaluate(stage.replaceTags(this.condition.toLowerCase(), replacements), stage.scope)) {
            console.log(this.modification);
            console.log(replacements);
            return stage.evaluate(stage.replaceTags(this.modification, replacements), stage.scope);
        }
        return stage.content;
    }
}