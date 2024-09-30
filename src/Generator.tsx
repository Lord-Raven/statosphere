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
        this.prompt = stage.processCode(data.prompt);
        if (!this.prompt.includes("{{system_prompt}}")) {
            this.prompt = `{{system_prompt}}\n${this.prompt}`;
        }
        if (!this.prompt.includes("{{post_history_instructions}}")) {
            this.prompt = `${this.prompt}\n{{post_history_instructions}}`;
        }
        this.minTokens = data.minSize;
        this.maxTokens = data.maxSize;
        this.updates = {};
        const updates: any[] = data.updates;
        Object.values(updates).forEach(update => this.updates[update.variable] = stage.processCode(update.setTo));
    }
}