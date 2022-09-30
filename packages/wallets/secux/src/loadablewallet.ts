import type { SecuxWebBLE } from "@secux/transport-webble";
import type { ITransport } from "@secux/transport";
import type { SecuxSOL } from "@secux/app-sol";
import type { SecuxDeviceNifty } from "@secux/protocol-device";
import type { FileAttachment, FileDestination } from "@secux/protocol-device/lib/interface";
import { BaseWalletAdapter, WalletDisconnectedError, WalletDisconnectionError, WalletNotConnectedError, WalletSignMessageError, WalletSignTransactionError } from "@solana/wallet-adapter-base";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { WalletConnectionError, WalletLoadError, WalletPublicKeyError } from "@solana/wallet-adapter-base";
import { WalletInterface } from "./interface";


export class LoadableWallet implements WalletInterface {
    #adapter: BaseWalletAdapter;
    #transport: ITransport | null = null;
    #path: string;
    #beginSendImage: boolean = false;

    constructor(base: BaseWalletAdapter, path: string) {
        this.#adapter = base;
        this.#path = path;
    }

    async connect(): Promise<PublicKey> {
        let ble: typeof SecuxWebBLE;
        let sol: typeof SecuxSOL;
        try {
            ble = (await import("@secux/transport-webble")).SecuxWebBLE;
            sol = (await import("@secux/app-sol")).SecuxSOL;
        } catch (error: any) {
            throw new WalletLoadError(error?.message, error);
        }

        try {
            const { DeviceType } = await import("@secux/transport/lib/interface");

            const device = await ble.Create(
                undefined,
                this.#disconnected,
                [DeviceType.crypto, DeviceType.nifty]
            );
            device.OnNotification = (data: Buffer) => {
                this.#beginSendImage = true;
            };

            await device.Connect();
            if (device.DeviceType === DeviceType.crypto) {
                const otp = prompt("Please enter otp showing on your SecuX");
                await device.SendOTP(otp!);
            }

            this.#transport = device;
        } catch (error: any) {
            throw new WalletConnectionError(error?.message, error);
        }

        try {
            const data = sol.prepareAddress(this.#path);
            const rsp = await this.#transport.Exchange(data as Buffer);
            const publicKey = new PublicKey(sol.resolveAddress(rsp));

            return publicKey;
        } catch (error: any) {
            throw new WalletPublicKeyError(error?.message, error);
        }
    }

    async disconnect(): Promise<void> {
        const transport = this.#transport;
        if (!transport) return;

        this.#transport = null;

        try {
            await transport.Disconnect();
        } catch (error: any) {
            throw new WalletDisconnectionError(error?.message, error);
        }
    }

    async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
        const transport = this.#transport;
        if (!transport) throw new WalletNotConnectedError();

        let sol: typeof SecuxSOL;
        try {
            sol = (await import("@secux/app-sol")).SecuxSOL;
        } catch (error: any) {
            throw new WalletLoadError(error?.message, error);
        }

        try {
            const publickey = this.#adapter.publicKey!;
            const account = publickey.toString();

            let sigData: Uint8Array;
            if (transaction instanceof VersionedTransaction) {
                sigData = transaction.message.serialize();
            }
            else {
                sigData = transaction.serializeMessage();
            }

            const { commandData } = sol.prepareSignSerialized(
                account,
                Buffer.from(sigData),
                [{ path: this.#path, account }]
            );
            const rsp = await transport.Exchange(commandData as Buffer);
            const signature = Buffer.from(sol.resolveSignature(rsp), "base64");

            if (transaction instanceof VersionedTransaction) {
                const signerIndex = transaction.message.staticAccountKeys.findIndex(pubkey => publickey.equals(pubkey));
                transaction.signatures[signerIndex] = signature;
            }
            else {
                transaction.addSignature(publickey, signature);
            }
        } catch (error: any) {
            throw new WalletSignTransactionError(error?.message, error);
        }

        return transaction;
    }

    async signTransactionWithImage<T extends Transaction | VersionedTransaction>(
        transaction: T, image: string | Buffer, metadata: FileAttachment
    ): Promise<T> {
        const transport = this.#transport;
        if (!transport) throw new WalletNotConnectedError();

        let nifty: typeof SecuxDeviceNifty;
        let fileDest: typeof FileDestination;
        try {
            nifty = (await import("@secux/protocol-device")).SecuxDeviceNifty;
            fileDest = (await import("@secux/protocol-device/lib/interface")).FileDestination;
        } catch (error: any) {
            throw new WalletLoadError(error?.message, error);
        }

        // prepare command data for image and check if device supported.
        let dataList: any;
        try {
            dataList = nifty.prepareSendImage(
                ".jpg",
                image,
                metadata,
                fileDest.CONFIRM
            );
        } catch (error) {
            // crypto wallet doesn't support image feature.
            return this.signTransaction(transaction);
        }

        try {
            // begin signing
            this.#beginSendImage = false;
            const task = this.signTransaction(transaction);
            while (!this.#beginSendImage) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // send image
            for (const data of dataList) await transport.Exchange(data as Buffer);

            // user interaction
            const tx = await task;

            return tx;
        } catch (error: any) {
            throw new WalletSignTransactionError(error?.message, error);
        }
    }

    async signMessage(message: Uint8Array): Promise<Uint8Array> {
        const transport = this.#transport;
        if (!transport) throw new WalletNotConnectedError();

        try {
            const { SecuxSOL } = await import("@secux/app-sol");
            const data = SecuxSOL.prepareSignMessage(this.#path, Buffer.from(message));
            const rsp = await transport.Exchange(data as Buffer);
            const signature = Buffer.from(SecuxSOL.resolveSignature(rsp), "base64");

            return signature;
        } catch (error: any) {
            throw new WalletSignMessageError(error?.message, error);
        }
    }

    #disconnected = () => {
        const transport = this.#transport;
        if (!transport) return;

        this.#transport = null;

        this.#adapter.emit("error", new WalletDisconnectedError());
        this.#adapter.emit("disconnect");
    }
}