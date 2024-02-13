require("dotenv").config();
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as phoenixSdk from "@ellipsis-labs/phoenix-sdk";

export const delay = (time: number) => {
  return new Promise<void>((resolve) => setTimeout(resolve, time));
};

export const execute = async () => {
  const REFRESH_FREQ_IN_MS = 2_000;
  const MAX_ITERATIONS = 3;
  const ORDER_LIFETIME_IN_SECONDS = 7;

  // edge
  const EDGE = 0.5;
  let counter = 0;

  if (!process.env.PRIVATE_KEY) {
    throw new Error("Missing PRIVATE_KEY in your .env file");
  }

  let privateKeyArray;
  try {
    privateKeyArray = JSON.parse(process.env.PRIVATE_KEY);
  } catch (error) {
    throw new Error("Error parsing PRIVATE_KEY.");
  }

  let traderKeypair = Keypair.fromSecretKey(new Uint8Array(privateKeyArray));
  console.log("Trader keypair: OK");

  const marketPubkey = new PublicKey(
    "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg",
  );
  const endpoint = "https://api.mainnet-beta.solana.com";
  const connection = new Connection(endpoint);

  // Create a Phoenix Client
  const client = await phoenixSdk.Client.create(connection);

  // Get the market metadata for the market you wish to trade on
  const marketState = client.marketStates.get(marketPubkey.toString());
  const marketData = marketState?.data;

  if (!marketData) {
    throw new Error("Market data not found");
  }

  const setupNewMakerIxs = await phoenixSdk.getMakerSetupInstructionsForMarket(
    connection,
    marketState,
    traderKeypair.publicKey,
  );

  if (setupNewMakerIxs.length !== 0) {
    const setup = new Transaction().add(...setupNewMakerIxs);
    const setupTxId = await sendAndConfirmTransaction(
      connection,
      setup,
      [traderKeypair],
      {
        skipPreflight: true,
        commitment: "confirmed",
      },
    );
    console.log(`Setup Tx Link: https://beta.solscan.io/tx/${setupTxId}`);
  } else {
    console.log("No setup required. Continuing...");
  }

  // COINBASE FairPrice
  do {
    // CANCEL ALL ORDERS PRIOR TO FairPrice
    const cancelAll = client.createCancelAllOrdersInstruction(
      marketPubkey.toString(),
      traderKeypair.publicKey,
    );

    try {
      const cancelTransaction = new Transaction().add(cancelAll);
      const txid = await sendAndConfirmTransaction(
        connection,
        cancelTransaction,
        [traderKeypair],
        {
          skipPreflight: true,
          commitment: "confirmed",
        },
      );

      console.log("Cancel tx link: https://beta.solscan.io/tx/" + txid);
    } catch (err) {
      console.log("Error: ", err);
      continue;
    }

    try {
      const response = await fetch(
        "https://api.coinbase.com/v2/prices/SOL-USD/spot",
      );

      if (!response.ok) {
        throw new Error(`HTTP error! Status ${response.status}`);
      }

      const data: any = await response.json();

      if (!data.data || !data.data.amount) {
        throw new Error("Invalid response structure");
      }

      const price = parseFloat(data.data.amount);
      let bidPrice = price - EDGE;
      let askPrice = price + EDGE;

      console.log(`SOL price: ${price}`);
      console.log(`Bid (buy) order at ${bidPrice}`);
      console.log(`Ask (sell) price at ${askPrice}`);

      const currentTime = Math.floor(Date.now() / 1000);

      // Bid
      const bidOrderTemplate: phoenixSdk.LimitOrderTemplate = {
        side: phoenixSdk.Side.Bid,
        priceAsFloat: bidPrice,
        sizeInBaseUnits: 1,
        selfTradeBehavior: phoenixSdk.SelfTradeBehavior.Abort,
        clientOrderId: 1,
        useOnlyDepositedFunds: false,
        lastValidSlot: undefined,
        lastValidUnixTimestampInSeconds: currentTime +
          ORDER_LIFETIME_IN_SECONDS,
      };

      const bidLimitOrderIx = client.getLimitOrderInstructionfromTemplate(
        marketPubkey.toBase58(),
        traderKeypair.publicKey,
        bidOrderTemplate,
      );

      // Ask
      const askOrderTemplate: phoenixSdk.LimitOrderTemplate = {
        side: phoenixSdk.Side.Ask,
        priceAsFloat: askPrice,
        sizeInBaseUnits: 1,
        selfTradeBehavior: phoenixSdk.SelfTradeBehavior.Abort,
        clientOrderId: 1,
        useOnlyDepositedFunds: false,
        lastValidSlot: undefined,
        lastValidUnixTimestampInSeconds: currentTime +
          ORDER_LIFETIME_IN_SECONDS,
      }

      const askLimitOrderIx = client.getLimitOrderInstructionfromTemplate(
        marketPubkey.toBase58(), 
        traderKeypair.publicKey, 
        askOrderTemplate,
      );

      // send instructions
      let instructions: TransactionInstruction[] = [];
      if (counter < MAX_ITERATIONS) {
        instructions = [bidLimitOrderIx, askLimitOrderIx];
      }

      // withdraw if finished
      if (counter === MAX_ITERATIONS) {
        const withdrawParams: phoenixSdk.WithdrawParams = {
            quoteLotsToWithdraw: null, 
            baseLotsToWithdraw: null,
        };

        const placeWithdraw = client.createWithdrawFundsInstruction(
            { withdrawFundsParams: withdrawParams }, 
            marketPubkey.toString(), 
            traderKeypair.publicKey
        );
        instructions.push(placeWithdraw);
      }

      try {
        const placeQuotesTx = new Transaction().add(...instructions);
        const placeQuotesTxId = await sendAndConfirmTransaction(
            connection, 
            placeQuotesTx, 
            [traderKeypair],
            { skipPreflight: true, commitment:"confirmed" }
        );

        console.log(
            `Place quotes ${bidPrice.toFixed(marketState.getPriceDecimalPlaces())}
            @
            ${askPrice.toFixed(marketState.getPriceDecimalPlaces())}
            `);

        console.log(`Tx: https://solscan.io/tx/${placeQuotesTxId}`);
      } catch (error) {
        console.log(`Error: ${error}`);
        continue;       
      }

      counter += 1;
      await delay(REFRESH_FREQ_IN_MS);
    } catch (error) {
      console.log(error);
    }
  } while (counter < MAX_ITERATIONS);
};

execute();
