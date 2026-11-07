import { Wallet } from 'ethers';

const w = Wallet.createRandom();
console.log('Скопируй в .env как WALLET_MNEMONIC (хранить в секрете!):\n');
console.log(w.mnemonic?.phrase);
