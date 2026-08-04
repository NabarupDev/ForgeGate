import { AuthService, RegisterDto, LoginDto } from './auth.service';
export declare class AuthController {
    private readonly authService;
    constructor(authService: AuthService);
    register(body: RegisterDto): Promise<{
        user: {
            id: string;
            email: string;
            name: string;
            tenant: {
                id: any;
                name: any;
                slug: any;
            };
            role: string;
        };
        tokens: {
            accessToken: string;
            refreshToken: string;
        };
    }>;
    login(body: LoginDto): Promise<{
        user: {
            id: string;
            email: string;
            name: string;
            tenant: {
                id: string;
                name: string;
                slug: string;
            };
            role: string;
        };
        tokens: {
            accessToken: string;
            refreshToken: string;
        };
    }>;
    logout(authHeader: string, body: {
        userId: string;
    }): Promise<{
        status: string;
        message: string;
    }>;
    verify(body: {
        token: string;
    }): Promise<any>;
    health(): {
        service: string;
        status: string;
        timestamp: string;
    };
}
export declare class AppModule {
}
