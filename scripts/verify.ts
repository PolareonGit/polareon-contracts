import { run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const filePath = path.join(deploymentsDir, `${network.name}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`No deployment found for network: ${network.name}`);
  }

  const deployment = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  console.log("Verifying implementation contract on Basescan...");
  console.log("Implementation:", deployment.implementation);

  try {
    await run("verify:verify", {
      address: deployment.implementation,
      constructorArguments: [],
    });
    console.log("✅ Implementation verified!");
  } catch (error: any) {
    if (error.message.includes("Already Verified")) {
      console.log("✅ Already verified!");
    } else {
      throw error;
    }
  }

  console.log("\nVerifying proxy contract...");
  console.log("Proxy:", deployment.proxy);

  try {
    await run("verify:verify", {
      address: deployment.proxy,
      constructorArguments: [],
    });
    console.log("✅ Proxy verified!");
  } catch (error: any) {
    if (error.message.includes("Already Verified")) {
      console.log("✅ Proxy already verified!");
    } else {
      console.log(
        "⚠️ Proxy verification skipped (this is normal for UUPS proxies):",
        error.message,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
