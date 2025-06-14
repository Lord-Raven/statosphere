import {Stage} from "./Stage";

export enum ContentCategory {
    Input = 'Input',
    PostInput = 'Post Input',
    Response = 'Response',
    PostResponse = 'Post Response',
    StageDirection = 'Stage Direction'
}

export class ContentRule {
    category: ContentCategory;
    condition: string;
    modification: string;

    constructor(data: any, stage: Stage) {
        this.category = data.category;
        this.condition = stage.processCode(data.condition);
        if (!this.condition || this.condition.trim().length == 0) this.condition = 'true';
        this.modification = stage.processCode(data.modification ?? '{{content}}');
    }

    evaluateAndApply(stage: Stage, targetCategory: ContentCategory): string {
        try {
            if (this.category == targetCategory && stage.evaluate(stage.replaceTags(this.condition), stage.scope)) {
                console.log(`Applying content rule: ${stage.replaceTags(this.modification)}`);
                return stage.evaluate(stage.replaceTags(this.modification), stage.scope);
            }
        } catch (error) {
            console.log(error);
            console.log("Received the above error while attempting to evaluate and apply the following content rule:")
            console.log(stage.replaceTags(this.condition))
            console.log(stage.replaceTags(this.modification));
        }
        return stage.content;
    }
}