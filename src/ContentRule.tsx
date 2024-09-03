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
        try {
            if (this.category == targetCategory && stage.evaluate(stage.replaceTags(this.condition, replacements), stage.scope)) {
                return stage.evaluate(stage.replaceTags(this.modification, replacements), stage.scope);
            }
        } catch (error) {
            console.log(error);
            console.log("Received the above error while attempting to evaluate and apply the following content rule:")
            console.log(stage.replaceTags(this.condition, replacements))
            console.log(stage.replaceTags(this.modification, replacements));
        }
        return stage.content;
    }
}