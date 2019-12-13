import { MakerClient, Order, TakerNegotiator, TryParams } from "comit-sdk";
import { formatEther } from "ethers/utils";
import * as readline from "readline";
import { toBitcoin } from "satoshi-bitcoin-ts";
import { Actor, checkEnvFile, printBalance, sleep, startClient } from "./lib";

(async function main() {
    checkEnvFile(process.env.DOTENV_CONFIG_PATH!);

    console.log("starting client...");
    const taker = await startClient("TAKER", 4);

    console.log(
        `Fund me with BTC please: ${await taker.bitcoinWallet.getAddress()}`
    );
    console.log(
        `Fund me with ETH please: ${await taker.ethereumWallet.getAccount()}`
    );

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    await printBalance(taker, "taker");
    rl.question(
        "Continue? (note, if you only funded just now, you might need to wait until the wallet has synced)",
        async () => {
            await executeWorkflow(taker);
            rl.close();
        }
    );
})();

async function executeWorkflow(taker: Actor) {
    await printBalance(taker, "taker");

    console.log("1. Ready to accept and order from the maker");

    const takerNegotiator = new TakerNegotiator(taker.comitClient);
    const makerClient = new MakerClient("http://localhost:2318/");

    const isOrderAcceptable = (order: Order) => {
        if (order.ask.asset !== "ether" || order.bid.asset !== "bitcoin") {
            return false;
        }

        const ether = parseFloat(order.ask.nominalAmount);
        const bitcoin = parseFloat(order.bid.nominalAmount);

        if (ether === 0 || bitcoin === 0) {
            // Let's do safe maths
            return false;
        }
        const minRate = 0.001;
        const orderRate = bitcoin / ether;
        console.log("Rate offered: ", orderRate);
        return orderRate > minRate;
    };
    const { order, swap } = await takerNegotiator.negotiateAndInitiateSwap(
        makerClient,
        "ETH-BTC",
        isOrderAcceptable
    );

    if (!swap) {
        throw new Error("Could not find an order or something else went wrong");
    }

    console.log(
        `Received latest order details: %s:%s for a rate of %d:%d`,
        order.ask.asset,
        order.bid.asset,
        order.ask.nominalAmount,
        order.bid.nominalAmount
    );

    // Retrieve the details (properties) of the swap
    const swapMessage = await swap.fetchDetails();
    const swapParameters = swapMessage.properties!.parameters;

    console.log(
        "Swap started! Swapping %d %s for %d %s",
        formatEther(swapParameters.alpha_asset.quantity),
        swapParameters.alpha_asset.name,
        toBitcoin(swapParameters.beta_asset.quantity),
        swapParameters.beta_asset.name
    );

    console.log("2. Continuing funding the Ethereum HTLC");

    // Define how often and how long the comit-js-sdk should try to execute the fund and redeem action.
    // For the purpose of testnet we set this to 40 minutes...
    const tryParams: TryParams = {
        maxTimeoutSecs: 40 * 60,
        tryIntervalSecs: 1,
    };

    console.log("Ethereum HTLC funded! TXID: ", await swap.fund(tryParams));

    console.log("4. Continuing redeeming the Bitcoin HTLC");

    const transactionId = await swap.redeem(tryParams);
    console.log("Bitcoin redeemed! TXID: ", transactionId);

    console.log("Swapped!");

    await sleep(3 * 60 * 1000);

    await printBalance(taker, "taker");

    process.exit();
}
