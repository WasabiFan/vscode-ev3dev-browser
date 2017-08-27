import { DebugSession, Event, TerminatedEvent } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';

/**
 * This interface should always match the schema found in the mock-debug extension manifest.
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the program to debug. */
    program: string;
    /** Download files before running. Default is true. */
    download?: boolean
}


class Ev3devBrowserDebugSession extends DebugSession {
    protected initializeRequest(response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments): void
    {
        response.body.supportTerminateDebuggee = true;
        this.sendResponse(response);
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
        this.sendEvent(new Event('ev3devBrowser.debugger.launch', args));
        // We don't send a response so that the pause button does not become enabled.
    }

    protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {
        switch (command) {
        case 'ev3devBrowser.debugger.terminate':
            this.sendEvent(new TerminatedEvent());
            this.sendResponse(response);
            break;
        }
    }
    
    protected disconnectRequest(response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments): void
    {
        this.sendEvent(new Event('ev3devBrowser.debugger.stop'));
        this.sendResponse(response);
    }
}

/**
 * Run the debug server.
 */
export function run(): void {
    DebugSession.run(Ev3devBrowserDebugSession);
}

if (require.main === module) {
    run();
}
