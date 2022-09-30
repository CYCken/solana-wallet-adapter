import {
    WalletAccountError, WalletConnectionError, WalletDisconnectedError, WalletNotConnectedError, WalletPublicKeyError, WalletSignMessageError, WalletSignTransactionError
} from "@solana/wallet-adapter-base";
import { PublicKey } from "@solana/web3.js";
import type { BaseWalletAdapter, EventEmitter } from "@solana/wallet-adapter-base";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { WalletInterface } from "./interface";
import { FileAttachment } from "@secux/protocol-device/lib/interface";


interface SecuxWallet extends EventEmitter {
    publicKey?: { toBytes(): Uint8Array };
    isConnected: boolean;
    signTransaction(transaction: Transaction | VersionedTransaction): Promise<Transaction>;
    signTransactionWithImage(
        transaction: Transaction | VersionedTransaction,
        image: string | Buffer,
        metadata: FileAttachment
    ): Promise<Transaction | VersionedTransaction>;
    signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
}

interface SecuxWindow extends Window {
    secuxwallet?: SecuxWallet
}
declare const window: SecuxWindow;


export class InstallableWallet implements WalletInterface {
    #adapter: BaseWalletAdapter;
    #wallet: SecuxWallet | null = null;

    constructor(base: BaseWalletAdapter) {
        this.#adapter = base;
    }

    async connect(): Promise<PublicKey> {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const wallet = window.secuxwallet;
        if (!wallet) throw new WalletConnectionError("cannot detect wallet.");

        if (!wallet.isConnected) {
            try {
                await wallet.connect();
            } catch (error: any) {
                throw new WalletConnectionError(error?.message, error);
            }
        }

        if (!wallet.publicKey) throw new WalletAccountError();

        let publicKey: PublicKey;
        try {
            publicKey = new PublicKey(wallet.publicKey.toBytes());
        } catch (error: any) {
            throw new WalletPublicKeyError(error?.message, error);
        }

        wallet.on('disconnect', this.#disconnected);

        this.#wallet = wallet;

        return publicKey;
    }

    async disconnect(): Promise<void> {
        const wallet = this.#wallet;
        if (!wallet) return;

        wallet.off("disconnect", this.#disconnected);

        this.#wallet = null;

        try {
            await wallet.disconnect();
        } catch (error: any) {
            throw new WalletDisconnectedError(error?.message, error);
        }
    }

    async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
        const wallet = this.#wallet;
        if (!wallet) throw new WalletNotConnectedError();

        try {
            return ((await wallet.signTransaction(transaction)) as T) || transaction;
        } catch (error: any) {
            throw new WalletSignTransactionError(error?.message, error);
        }
    }

    async signTransactionWithImage<T extends Transaction | VersionedTransaction>(
        transaction: T, image: string | Buffer, metadata: FileAttachment
    ): Promise<T> {
        const wallet = this.#wallet;
        if (!wallet) throw new WalletNotConnectedError();

        try {
            return ((await wallet.signTransactionWithImage(transaction, image, metadata)) as T) || transaction;
        } catch (error: any) {
            throw new WalletSignTransactionError(error?.message, error);
        }
    }

    async signMessage(message: Uint8Array): Promise<Uint8Array> {
        const wallet = this.#wallet;
        if (!wallet) throw new WalletNotConnectedError();

        try {
            const { signature } = await wallet.signMessage(message);
            return signature;
        } catch (error: any) {
            throw new WalletSignMessageError(error?.message, error);
        }
    }

    #disconnected = () => {
        const wallet = this.#wallet;
        if (!wallet) return;

        wallet.off("disconnect", this.#disconnected);

        this.#wallet = null;

        this.#adapter.emit("error", new WalletDisconnectedError());
        this.#adapter.emit("disconnect");
    }
}