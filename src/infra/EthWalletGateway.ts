import { HDNodeWallet, JsonRpcProvider, Mnemonic } from 'ethers';
import { AddressGenerator, BalanceReader, FundsSender } from '../domain/ports';

/**
 * Адаптер к блокчейну Ethereum (Sepolia testnet).
 * Одна мнемоника -> бесконечно много адресов (HD-кошелёк, путь m/44'/60'/0'/0/index).
 * Чтобы добавить Bitcoin/Tron, пишем новый класс с теми же интерфейсами (принцип O).
 */
export class EthWalletGateway implements AddressGenerator, BalanceReader, FundsSender {
  private readonly provider: JsonRpcProvider;
  private readonly root: HDNodeWallet;

  constructor(rpcUrl: string, mnemonicPhrase: string) {
    this.provider = new JsonRpcProvider(rpcUrl);
    this.root = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(mnemonicPhrase), "m/44'/60'/0'/0");
  }

  deriveAddress(index: number): string {
    return this.root.deriveChild(index).address;
  }

  getBalance(address: string): Promise<bigint> {
    return this.provider.getBalance(address);
  }

  async getConfirmedBalance(address: string, confirmations: number): Promise<bigint> {
    const latest = await this.provider.getBlockNumber();
    // Транзакция в блоке B имеет N подтверждений, когда latest - B + 1 >= N
    const block = Math.max(latest - confirmations + 1, 0);
    return this.provider.getBalance(address, block);
  }

  async sweep(index: number, to: string): Promise<{ txHash: string; sentWei: bigint }> {
    const wallet = this.root.deriveChild(index).connect(this.provider);
    const balance = await this.provider.getBalance(wallet.address);

    const fee = await this.provider.getFeeData();
    const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice;
    if (maxFeePerGas === null || maxFeePerGas === undefined) {
      throw new Error('Cannot get gas price from network');
    }
    const gasLimit = 21000n; // обычный перевод ETH
    const cost = gasLimit * maxFeePerGas;
    if (balance <= cost) throw new Error('Balance is not enough to pay the network fee');

    const value = balance - cost;
    const tx = await wallet.sendTransaction({
      to,
      value,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n,
    });
    return { txHash: tx.hash, sentWei: value };
  }
}
