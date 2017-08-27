import * as dnode from 'dnode';
import * as net from 'net';
import * as path from 'path';
import * as ssh2 from 'ssh2';
import * as ssh2Streams from 'ssh2-streams';
import * as vscode from 'vscode';

import * as dnssd from './dnssd';

/**
 * Object that represents a remote ev3dev device.
 */
export class Device extends vscode.Disposable {
    private readonly client: ssh2.Client;
    private sftp: ssh2.SFTPWrapper;
    private shellServer: net.Server;
    private _homeDirectoryAttr: ssh2Streams.Attributes;
    private _isConnecting = false;
    private _isConnected = false;

    /**
     * The username requested by the device.
     *
     * This value comes from a mDNS text record.
     */
    public readonly username: string;

    private readonly _onWillConnect = new vscode.EventEmitter<void>();
    /**
     * Event that fires when a connection is initiated.
     *
     * This will be followed by either onDidConnect or onDidDisconnect.
     */
    public readonly onWillConnect = this._onWillConnect.event;

    private readonly _onDidConnect = new vscode.EventEmitter<void>();
    /**
     * Event that fires when a connection has completed successfully.
     */
    public readonly onDidConnect = this._onDidConnect.event;

    private readonly _onDidDisconnect = new vscode.EventEmitter<void>();
    /**
     * Event that fires when a connection has been closed.
     */
    public readonly onDidDisconnect = this._onDidDisconnect.event;

    constructor(private readonly service: dnssd.Service) {
        super(() => {
            this.disconnect();
            this._onWillConnect.dispose();
            this._onDidConnect.dispose();
            this._onDidDisconnect.dispose();
            this.client.destroy();
        });
        this.username = service.txt['ev3dev.robot.user']
        this.client = new ssh2.Client();
        this.client.on('end', () => {

        });
        this.client.on('close', () => {

        });
        this.client.on('keyboard-interactive', async (name, instructions, lang, prompts, finish) => {
            const answers = new Array<string>();
            for (const p of prompts) {
                const choice = await vscode.window.showInputBox({
                    ignoreFocusOut: true,
                    password: !p.echo,
                    prompt:  p.prompt
                });
                answers.push(choice);
            }
            // another type binding workaround
            finish(answers);
        });
    }

    /**
     * Connect to the device using SSH.
     */
    public async connect(): Promise<void> {
        this._isConnecting = true;
        this._onWillConnect.fire();
        await this.connectClient();
        try {
            this.sftp = await this.getSftp();
            this._homeDirectoryAttr = await this.stat(this.homeDirectoryPath);
            this.shellServer = await this.createServer();
            this._isConnecting = false;
            this._isConnected = true;
            this._onDidConnect.fire();
        }
        catch (err) {
            this._isConnecting = false;
            this.disconnect();
            throw err;
        }
    }

    private connectClient(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.client.once('ready', resolve);
            this.client.once('error', reject);
            this.client.connect({
                host: this.service.address,
                username: this.username,
                password: vscode.workspace.getConfiguration('ev3devBrowser').get('password'),
                tryKeyboard: true
            });
        });
    }

    private getSftp(): Promise<ssh2.SFTPWrapper> {
        return new Promise((resolve, reject) => {
            this.client.sftp((err, sftp) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(sftp);
            });
        });
    }

    private createServer(): Promise<net.Server> {
        return new Promise((resolve, reject) => {
            const server = net.createServer(socket => {
                const d = dnode({
                    shell: (ttySettings, dataOut, dataErr, ready, exit) => {
                        this.shell(ttySettings).then(ch => {
                            ch.stdout.on('data', data => {
                                dataOut(data.toString('base64'));
                            });
                            ch.stderr.on('data', data => {
                                dataErr((<Buffer> data).toString('base64'));
                            });
                            ch.on('error', err => {
                                vscode.window.showErrorMessage(`SSH connection error: ${err.message}`);
                                exit();
                                ch.destroy();
                                d.destroy();
                            });
                            ch.on('close', () => {
                                exit();
                                ch.destroy();
                                d.destroy();
                            });
                            ready((rows, cols) => {
                                // resize callback
                                ch.setWindow(rows, cols, 0, 0);
                            }, data => {
                                // dataIn callback
                                ch.stdin.write(new Buffer(data, 'base64'));
                            });
                        });
                    }
                }, {
                    // weak requires native module, which we can't use in vscode
                    weak: false
                });
                socket.on('error', err => {
                    // TODO: not sure what to do here.
                    // The default dnode implementation only ignores EPIPE.
                    // On Windows, we can also get ECONNRESET when a client disconnects.
                });
                socket.pipe(d).pipe(socket);
            });
            server.listen(0, '127.0.0.1');
            server.once('listening', () => resolve(server));
            server.once('error', reject);
        });
    }

    /**
     * Disconnect from the device.
     */
    public disconnect(): void {
        this._isConnected = false;
        if (this.shellServer) {
            this.shellServer.close();
            this.shellServer = null;
        }
        if (this.sftp) {
            this.sftp.end();
            this.sftp = null;
        }
        this.client.end();
        this._onDidDisconnect.fire();
    }

    /**
     * Tests if a connection is currently in progress.
     */
    public get isConnecting(): boolean {
        return this._isConnecting;
    }

    /**
     * Tests if a device is currently connected.
     */
    public get isConnected(): boolean {
        return this._isConnected;
    }

    /**
     * Gets the name of the device.
     */
    public get name(): string {
        return this.service.name;
    }

    /**
     * Get the file attributes of the home directory.
     */
    public get homeDirectoryAttr(): ssh2Streams.Attributes {
        return this._homeDirectoryAttr;
    }

    /**
     * Gets the home directory path for the device.
     */
    public get homeDirectoryPath(): string {
        return this.service.txt['ev3dev.robot.home'] || `/home/${this.username}`;
    }

    /**
     * Gets the TCP port where the shell server is listening.
     */
    public get shellPort(): number {
        return this.shellServer.address().port;
    }

    /**
     * Sets file permissions.
     * @param path The path to a file or directory
     * @param mode The file permissions
     */
    public chmod(path: string, mode: string | number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp.chmod(path, mode, err => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }

    /**
     * Executes a command on the remote device.
     * @param command The absolute path of the command.
     */
    public exec(command: string): Promise<ssh2.Channel> {
        return new Promise((resolve, reject) => {
            const options = {
                env: vscode.workspace.getConfiguration('ev3devBrowser').get('env')
            };
            this.client.exec(command, options, (err, channel) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(channel);
            });
        });
    }

    /**
     * Starts a new shell on the remote device.
     * @param window Optional pty settings or false to not allocate a pty.
     */
    public shell(window?: false | ssh2.PseudoTtyOptions): Promise<ssh2.ClientChannel> {
        return new Promise((resolve, reject) => {
            const options = <ssh2.ShellOptions> {
                env: vscode.workspace.getConfiguration('ev3devBrowser').get('env')
            };
            this.client.shell(window, options, (err, stream) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(stream);
                }
            });
        });
    }

    /**
     * Create a directory.
     * @param path the path of the directory.
     */
    public mkdir(path: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp.mkdir(path, err => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }

    /**
     * Recursively create a directory (equivalent of mkdir -p).
     * @param path the path of the directory
     */
    public async mkdir_p(path: string): Promise<void> {
        const names = path.split('/');
        let part = '';
        while (names.length) {
            part += names.shift() + '/';
            // have to make sure the directory exists on the remote device first
            try {
                await this.stat(part);
            }
            catch (err) {
                if (err.code != 2 /* file does not exist */) {
                    throw err;
                }
                await this.mkdir(part);
            }
        }
    }

    /**
     * Copy a local file to the remote device.
     * @param local The path to a local file.
     * @param remote The remote path where the file will be saved.
     */
    public put(local: string, remote: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp.fastPut(local, remote, (err) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }

    /**
     * List the contents of a remote directory.
     * @param path The path to a directory.
     */
    public ls(path: string): Promise<ssh2Streams.FileEntry[]> {
        return new Promise((resolve, reject) => {
            this.sftp.readdir(path, (err, list) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(list);
                }
            });
        });
    }

    /**
     * Stat a remote file or directory.
     * @param path The path to a remote file or directory.
     */
    public stat(path: string): Promise<ssh2Streams.Stats> {
        return new Promise((resolve, reject) => {
            this.sftp.stat(path, (err, stats) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(stats);
                }
            });
        });
    }

    /**
     * Remove a remote file.
     * @param path The path to a file or symlink to remove (unlink)
     */
    public rm(path: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp.unlink(path, err => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            })
        });
    }

    public getSystemInfo(): Promise<string> {
        return new Promise(async (resolve, reject) => {
            const conn = await this.exec('ev3dev-sysinfo');
            let sysinfoString = '';
            conn.stdout.on('data', buffer => sysinfoString += buffer.toString());
            conn.stdout.once('error', (err) => {
                conn.close();
                reject(err);
            });

            conn.stdout.once('end', () => resolve(sysinfoString));
        });
    }

    private static dnssdClient: dnssd.Client;
    private static async getDnssdClient(): Promise<dnssd.Client> {
        if (!Device.dnssdClient) {
            Device.dnssdClient = await dnssd.getInstance();
        }
        return Device.dnssdClient;
    }

    /**
     * Use a quick-pick to browse discovered devices and select one.
     * @returns A new Device or null if the user canceled the request
     */
    public static async pickDevice(): Promise<Device> {
        const selectedItem = await new Promise<ServiceItem>(async (resolve, reject) => {
                // start browsing for devices
                const dnssdClient = await Device.getDnssdClient();
                const browser = await dnssdClient.browse({ service: 'sftp-ssh' });
                const items = new Array<ServiceItem>();
                let cancelSource: vscode.CancellationTokenSource;
                let done = false;

                // if a device is added or removed, cancel the quick-pick
                // and then show a new one with the update list
                browser.on('added', (service) => {
                    if (service.txt['ev3dev.robot.home']) {
                        // this looks like an ev3dev device
                        const item = new ServiceItem(service);
                        items.push(item);
                        cancelSource.cancel();
                    }
                });
                browser.on('removed', (service) => {
                    const index = items.findIndex(si => si.service == service);
                    if (index > -1) {
                        items.splice(index, 1);
                        cancelSource.cancel();
                    }
                });

                // if there is a browser error, cancel the quick-pick and show
                // an error message
                browser.on('error', err => {
                    cancelSource.cancel();
                    browser.destroy();
                    done = true;
                    reject(err);
                });

                while (!done) {
                    cancelSource = new vscode.CancellationTokenSource();
                    // using this promise in the quick-pick will cause a progress
                    // bar to show if there are no items.
                    const list = new Promise<ServiceItem[]>((resolve, reject) => {
                        if (items) {
                            resolve(items);
                        }
                        else {
                            reject();
                        }
                    })
                    const selected = await vscode.window.showQuickPick(list, {
                        ignoreFocusOut: true,
                        placeHolder: "Searching for devices..."
                    }, cancelSource.token);
                    if (cancelSource.token.isCancellationRequested) {
                        continue;
                    }
                    browser.destroy();
                    done = true;
                    resolve(selected);
                }
            });
        if (!selectedItem) {
            // cancelled
            return null;
        }

        return new Device(selectedItem.service);
    }
}

/**
 * Quick pick item used in DeviceManager.pickDevice().
 */
class ServiceItem implements vscode.QuickPickItem {
    readonly label: string;
    readonly description: string;

    constructor (public service: dnssd.Service) {
        this.label = service.name;
    }
}
