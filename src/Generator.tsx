import {Stage} from "./Stage";

export enum Phase {
    Initialization = 'Initialization',
    OnInput = 'On Input',
    OnResponse = 'On Response'
}

export class Generator {
    name: any;
    phase: Phase;
    condition: any;
    prompt: any;
    minTokens: any;
    maxTokens: any;
    updates: {[key: string]: string}

    constructor(data: any, stage: Stage) {
        this.name = data.name;
        this.phase = data.phase;
        this.condition = data.condition;
        this.prompt = `${!data.prompt.includes("{{system_prompt}}") ? "{{system_prompt}}\n" : ""}${stage.processCode(data.prompt)}${!data.prompt.includes("{{post_history_instructions}}") ? "\n{{post_history_instructions}}" : ""}`;
        this.minTokens = data.minSize;
        this.maxTokens = data.maxSize;
        this.updates = {};
        const updates: any[] = data.updates;
        Object.values(updates).forEach(update => this.updates[update.variable] = stage.processCode(update.setTo));
    }
}