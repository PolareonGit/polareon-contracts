import * as fs from "fs";
import * as path from "path";

/**
 * Export ABI and deployment addresses for consumption by the backend monorepo.
 * Output: ./exports/PolareonTokenPool.json
 */
async function main() {
  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    "PolareonTokenPool.sol",
    "PolareonTokenPool.json",
  );

  if (!fs.existsSync(artifactPath)) {
    throw new Error("Artifacts not found. Run `npx hardhat compile` first.");
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));

  // Collect deployment addresses across networks
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const addresses: Record<string, { proxy: string; implementation: string }> =
    {};

  if (fs.existsSync(deploymentsDir)) {
    const files = fs
      .readdirSync(deploymentsDir)
      .filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const networkName = path.basename(file, ".json");
      const data = JSON.parse(
        fs.readFileSync(path.join(deploymentsDir, file), "utf-8"),
      );
      addresses[networkName] = {
        proxy: data.proxy,
        implementation: data.implementation,
      };
    }
  }

  // Build export object
  const exported = {
    contractName: "PolareonTokenPool",
    abi: artifact.abi,
    addresses,
    generatedAt: new Date().toISOString(),
  };

  const exportsDir = path.join(__dirname, "..", "exports");
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }

  const exportPath = path.join(exportsDir, "PolareonTokenPool.json");
  fs.writeFileSync(exportPath, JSON.stringify(exported, null, 2));
  console.log(`✅ ABI + addresses exported to: exports/PolareonTokenPool.json`);
  console.log(
    `   Networks: ${
      Object.keys(addresses).join(", ") || "(none deployed yet)"
    }`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
