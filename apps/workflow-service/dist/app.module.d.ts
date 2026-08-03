export declare class WorkflowController {
    createWorkflow(dto: any): {
        id: string;
        name: any;
        status: string;
        stepsCount: any;
    };
    triggerExecution(id: string): {
        executionId: string;
        workflowId: string;
        status: string;
        retryPolicy: string;
    };
    health(): {
        service: string;
        engine: string;
        status: string;
    };
}
export declare class AppModule {
}
