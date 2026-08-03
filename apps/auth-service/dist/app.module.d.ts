export declare class AuthController {
    register(body: any): {
        status: string;
        email: any;
    };
    login(body: any): {
        accessToken: string;
        refreshToken: string;
    };
    health(): {
        service: string;
        status: string;
    };
}
export declare class AppModule {
}
