import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { PolareonVault, MockERC20, MockFeeToken } from "../typechain-types";

// ─── Helpers ───────────────────────────────────────────────────────

const CYCLE_ID = ethers.keccak256(ethers.toUtf8Bytes("cycle-1"));
const CYCLE_ID_2 = ethers.keccak256(ethers.toUtf8Bytes("cycle-2"));
const CYCLE_ID_3 = ethers.keccak256(ethers.toUtf8Bytes("cycle-3"));

const PRIZE_AMOUNT = ethers.parseUnits("500", 6); // 500 USDC
const DEPOSIT_AMOUNT = ethers.parseUnits("500", 6);

enum CycleStatus {
  Created = 0,
  Claimed = 1,
  Cancelled = 2,
}

async function signClaim(
  contract: PolareonVault,
  operatorSigner: HardhatEthersSigner,
  cycleId: string,
  user: string,
  amount: bigint,
  nonce: bigint,
): Promise<string> {
  const domain = {
    name: "PolareonVault",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await contract.getAddress(),
  };

  const types = {
    Claim: [
      { name: "cycleId", type: "bytes32" },
      { name: "user", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };

  const value = { cycleId, user, amount, nonce };
  return operatorSigner.signTypedData(domain, types, value);
}

// ─── Fixture ───────────────────────────────────────────────────────

async function deployFixture() {
  const [deployer, owner, operator, user1, user2, attacker] =
    await ethers.getSigners();

  // Deploy mock USDC
  const MockERC20Factory = await ethers.getContractFactory("MockERC20");
  const usdc = (await MockERC20Factory.deploy(
    "USD Coin",
    "USDC",
    6,
  )) as MockERC20;

  // Deploy mock fee-on-transfer token
  const MockFeeTokenFactory = await ethers.getContractFactory("MockFeeToken");
  const feeToken = (await MockFeeTokenFactory.deploy()) as MockFeeToken;

  // Deploy PolareonVault via UUPS proxy
  const Factory = await ethers.getContractFactory("PolareonVault");
  const proxy = (await upgrades.deployProxy(
    Factory,
    [owner.address, operator.address, await usdc.getAddress()],
    { initializer: "initialize", kind: "uups" },
  )) as unknown as PolareonVault;

  // Mint USDC to operator for deposits
  await usdc.mint(operator.address, ethers.parseUnits("100000", 6));
  // Approve vault to spend operator's USDC
  await usdc
    .connect(operator)
    .approve(await proxy.getAddress(), ethers.MaxUint256);

  // Mint USDC to owner for withdrawExcess testing (owner receives withdrawals)
  await usdc.mint(owner.address, ethers.parseUnits("10000", 6));

  // Time helpers
  const now = await time.latest();
  const START_TIME = now + 60; // starts in 1 minute
  const END_TIME = START_TIME + 7 * 24 * 60 * 60; // 1 week

  return {
    proxy,
    usdc,
    feeToken,
    deployer,
    owner,
    operator,
    user1,
    user2,
    attacker,
    START_TIME,
    END_TIME,
  };
}

/** Deploy + deposit + create a funded active cycle */
async function activeCycleFixture() {
  const f = await deployFixture();

  // Deposit
  await f.proxy.connect(f.operator).depositPrize(DEPOSIT_AMOUNT);

  // Create cycle
  await f.proxy
    .connect(f.operator)
    .createCycle(CYCLE_ID, PRIZE_AMOUNT, f.START_TIME, f.END_TIME);

  // Advance to active window
  await time.increaseTo(f.START_TIME);

  return { ...f, cycleId: CYCLE_ID };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("PolareonVault", function () {
  // ════════════════════════════════════════════════
  //  Initialization
  // ════════════════════════════════════════════════

  describe("Initialization", function () {
    it("should set owner correctly", async function () {
      const { proxy, owner } = await loadFixture(deployFixture);
      expect(await proxy.owner()).to.equal(owner.address);
    });

    it("should set operator correctly", async function () {
      const { proxy, operator } = await loadFixture(deployFixture);
      expect(await proxy.operator()).to.equal(operator.address);
    });

    it("should set token correctly", async function () {
      const { proxy, usdc } = await loadFixture(deployFixture);
      expect(await proxy.token()).to.equal(await usdc.getAddress());
    });

    it("should start with zero vault balance", async function () {
      const { proxy } = await loadFixture(deployFixture);
      expect(await proxy.getVaultBalance()).to.equal(0);
    });

    it("should start with no active cycle", async function () {
      const { proxy } = await loadFixture(deployFixture);
      expect(await proxy.getCurrentCycleId()).to.equal(ethers.ZeroHash);
    });

    it("should revert if initialized with zero owner", async function () {
      const Factory = await ethers.getContractFactory("PolareonVault");
      await expect(
        upgrades.deployProxy(
          Factory,
          [
            ethers.ZeroAddress,
            ethers.Wallet.createRandom().address,
            ethers.Wallet.createRandom().address,
          ],
          { initializer: "initialize", kind: "uups" },
        ),
      ).to.be.revertedWithCustomError(Factory, "InvalidAddress");
    });

    it("should revert if initialized with zero operator", async function () {
      const Factory = await ethers.getContractFactory("PolareonVault");
      await expect(
        upgrades.deployProxy(
          Factory,
          [
            ethers.Wallet.createRandom().address,
            ethers.ZeroAddress,
            ethers.Wallet.createRandom().address,
          ],
          { initializer: "initialize", kind: "uups" },
        ),
      ).to.be.revertedWithCustomError(Factory, "InvalidAddress");
    });

    it("should revert if initialized with zero token", async function () {
      const Factory = await ethers.getContractFactory("PolareonVault");
      await expect(
        upgrades.deployProxy(
          Factory,
          [
            ethers.Wallet.createRandom().address,
            ethers.Wallet.createRandom().address,
            ethers.ZeroAddress,
          ],
          { initializer: "initialize", kind: "uups" },
        ),
      ).to.be.revertedWithCustomError(Factory, "InvalidAddress");
    });
  });

  // ════════════════════════════════════════════════
  //  Owner Functions
  // ════════════════════════════════════════════════

  describe("Owner Functions", function () {
    it("should allow owner to set operator", async function () {
      const { proxy, owner, user1 } = await loadFixture(deployFixture);
      await expect(proxy.connect(owner).setOperator(user1.address))
        .to.emit(proxy, "OperatorUpdated")
        .withArgs(await proxy.operator(), user1.address);
      expect(await proxy.operator()).to.equal(user1.address);
    });

    it("should revert setOperator from non-owner", async function () {
      const { proxy, operator, user1 } = await loadFixture(deployFixture);
      await expect(
        proxy.connect(operator).setOperator(user1.address),
      ).to.be.revertedWithCustomError(proxy, "OwnableUnauthorizedAccount");
    });

    it("should revert setOperator with zero address", async function () {
      const { proxy, owner } = await loadFixture(deployFixture);
      await expect(
        proxy.connect(owner).setOperator(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(proxy, "InvalidAddress");
    });

    it("should allow owner to pause", async function () {
      const { proxy, owner } = await loadFixture(deployFixture);
      await proxy.connect(owner).pause();
      expect(await proxy.paused()).to.be.true;
    });

    it("should allow owner to unpause", async function () {
      const { proxy, owner } = await loadFixture(deployFixture);
      await proxy.connect(owner).pause();
      await proxy.connect(owner).unpause();
      expect(await proxy.paused()).to.be.false;
    });

    it("should revert pause from non-owner", async function () {
      const { proxy, operator } = await loadFixture(deployFixture);
      await expect(
        proxy.connect(operator).pause(),
      ).to.be.revertedWithCustomError(proxy, "OwnableUnauthorizedAccount");
    });

    it("should revert unpause from non-owner", async function () {
      const { proxy, owner, operator } = await loadFixture(deployFixture);
      await proxy.connect(owner).pause();
      await expect(
        proxy.connect(operator).unpause(),
      ).to.be.revertedWithCustomError(proxy, "OwnableUnauthorizedAccount");
    });
  });

  // ════════════════════════════════════════════════
  //  depositPrize
  // ════════════════════════════════════════════════

  describe("depositPrize", function () {
    it("should deposit and increase vault balance", async function () {
      const { proxy, operator } = await loadFixture(deployFixture);
      await expect(proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT))
        .to.emit(proxy, "PrizeDeposited")
        .withArgs(DEPOSIT_AMOUNT, DEPOSIT_AMOUNT);
      expect(await proxy.getVaultBalance()).to.equal(DEPOSIT_AMOUNT);
    });

    it("should accumulate multiple deposits", async function () {
      const { proxy, operator } = await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      expect(await proxy.getVaultBalance()).to.equal(DEPOSIT_AMOUNT * 2n);
    });

    it("should revert deposit from non-operator", async function () {
      const { proxy, user1, usdc } = await loadFixture(deployFixture);
      await usdc.mint(user1.address, DEPOSIT_AMOUNT);
      await usdc
        .connect(user1)
        .approve(await proxy.getAddress(), DEPOSIT_AMOUNT);
      await expect(
        proxy.connect(user1).depositPrize(DEPOSIT_AMOUNT),
      ).to.be.revertedWithCustomError(proxy, "OnlyOperator");
    });

    it("should revert deposit of zero amount", async function () {
      const { proxy, operator } = await loadFixture(deployFixture);
      await expect(
        proxy.connect(operator).depositPrize(0),
      ).to.be.revertedWithCustomError(proxy, "InvalidAmount");
    });

    it("should revert deposit when paused", async function () {
      const { proxy, owner, operator } = await loadFixture(deployFixture);
      await proxy.connect(owner).pause();
      await expect(
        proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT),
      ).to.be.revertedWithCustomError(proxy, "EnforcedPause");
    });

    it("should revert deposit of fee-on-transfer token", async function () {
      const { owner, operator, feeToken } = await loadFixture(deployFixture);
      // Deploy a vault with fee token
      const Factory = await ethers.getContractFactory("PolareonVault");
      const feeVault = (await upgrades.deployProxy(
        Factory,
        [owner.address, operator.address, await feeToken.getAddress()],
        { initializer: "initialize", kind: "uups" },
      )) as unknown as PolareonVault;

      await feeToken.mint(operator.address, ethers.parseUnits("1000", 18));
      await feeToken
        .connect(operator)
        .approve(await feeVault.getAddress(), ethers.MaxUint256);

      await expect(
        feeVault.connect(operator).depositPrize(ethers.parseUnits("100", 18)),
      ).to.be.revertedWithCustomError(feeVault, "FeeOnTransferNotSupported");
    });

    it("should match actual token balance after deposit", async function () {
      const { proxy, operator, usdc } = await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      const actual = await usdc.balanceOf(await proxy.getAddress());
      expect(await proxy.getVaultBalance()).to.equal(actual);
    });
  });

  // ════════════════════════════════════════════════
  //  createCycle
  // ════════════════════════════════════════════════

  describe("createCycle", function () {
    it("should create a cycle successfully", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await expect(
        proxy
          .connect(operator)
          .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME),
      )
        .to.emit(proxy, "CycleCreated")
        .withArgs(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);

      expect(await proxy.getCurrentCycleId()).to.equal(CYCLE_ID);
    });

    it("should store cycle data correctly", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);

      const cycle = await proxy.getCycle(CYCLE_ID);
      expect(cycle.winner).to.equal(ethers.ZeroAddress);
      expect(cycle.status).to.equal(CycleStatus.Created);
      expect(cycle.prizeAmount).to.equal(PRIZE_AMOUNT);
      expect(cycle.startTime).to.equal(START_TIME);
      expect(cycle.endTime).to.equal(END_TIME);
    });

    it("should revert if cycleId already exists", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);

      // Let cycle end naturally
      await time.increaseTo(END_TIME + 1);

      await expect(
        proxy
          .connect(operator)
          .createCycle(CYCLE_ID, PRIZE_AMOUNT, END_TIME + 100, END_TIME + 1000),
      ).to.be.revertedWithCustomError(proxy, "CycleAlreadyExists");
    });

    it("should revert with zero prize amount", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await expect(
        proxy.connect(operator).createCycle(CYCLE_ID, 0, START_TIME, END_TIME),
      ).to.be.revertedWithCustomError(proxy, "InvalidAmount");
    });

    it("should revert with invalid time window", async function () {
      const { proxy, operator, START_TIME } = await loadFixture(deployFixture);
      await expect(
        proxy
          .connect(operator)
          .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, START_TIME),
      ).to.be.revertedWithCustomError(proxy, "InvalidTimeWindow");
    });

    it("should revert from non-operator", async function () {
      const { proxy, user1, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await expect(
        proxy
          .connect(user1)
          .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME),
      ).to.be.revertedWithCustomError(proxy, "OnlyOperator");
    });

    it("should revert when paused", async function () {
      const { proxy, owner, operator, START_TIME, END_TIME } =
        await loadFixture(deployFixture);
      await proxy.connect(owner).pause();
      await expect(
        proxy
          .connect(operator)
          .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME),
      ).to.be.revertedWithCustomError(proxy, "EnforcedPause");
    });

    it("should revert if another cycle is still active", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);

      await expect(
        proxy
          .connect(operator)
          .createCycle(
            CYCLE_ID_2,
            PRIZE_AMOUNT,
            START_TIME + 100,
            END_TIME + 100,
          ),
      ).to.be.revertedWithCustomError(proxy, "AnotherCycleActive");
    });

    it("should allow creating after previous cycle ended naturally", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);

      // Advance past endTime
      await time.increaseTo(END_TIME + 1);

      const newStart = END_TIME + 100;
      const newEnd = newStart + 7 * 24 * 60 * 60;
      await expect(
        proxy
          .connect(operator)
          .createCycle(CYCLE_ID_2, PRIZE_AMOUNT, newStart, newEnd),
      ).to.emit(proxy, "CycleCreated");

      expect(await proxy.getCurrentCycleId()).to.equal(CYCLE_ID_2);
    });

    it("should allow creating after previous cycle was claimed", async function () {
      const f = await loadFixture(activeCycleFixture);

      // Claim
      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );
      await f.proxy
        .connect(f.user1)
        .claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig);

      // Now create a new cycle
      const newStart = f.END_TIME + 100;
      const newEnd = newStart + 7 * 24 * 60 * 60;

      // Deposit more for the new cycle
      await f.proxy.connect(f.operator).depositPrize(DEPOSIT_AMOUNT);

      await expect(
        f.proxy
          .connect(f.operator)
          .createCycle(CYCLE_ID_2, PRIZE_AMOUNT, newStart, newEnd),
      ).to.emit(f.proxy, "CycleCreated");
    });

    it("should allow creating after previous cycle was cancelled", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);
      await proxy.connect(operator).cancelCycle(CYCLE_ID);

      const newStart = START_TIME + 100;
      const newEnd = newStart + 7 * 24 * 60 * 60;
      await expect(
        proxy
          .connect(operator)
          .createCycle(CYCLE_ID_2, PRIZE_AMOUNT, newStart, newEnd),
      ).to.emit(proxy, "CycleCreated");
    });
  });

  // ════════════════════════════════════════════════
  //  cancelCycle
  // ════════════════════════════════════════════════

  describe("cancelCycle", function () {
    it("should cancel a Created cycle", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);

      await expect(proxy.connect(operator).cancelCycle(CYCLE_ID))
        .to.emit(proxy, "CycleCancelled")
        .withArgs(CYCLE_ID);

      const cycle = await proxy.getCycle(CYCLE_ID);
      expect(cycle.status).to.equal(CycleStatus.Cancelled);
    });

    it("should clear currentCycleId on cancel", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);
      await proxy.connect(operator).cancelCycle(CYCLE_ID);

      expect(await proxy.getCurrentCycleId()).to.equal(ethers.ZeroHash);
    });

    it("should NOT transfer funds on cancel (vault balance unchanged)", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);

      const balanceBefore = await proxy.getVaultBalance();
      await proxy.connect(operator).cancelCycle(CYCLE_ID);
      const balanceAfter = await proxy.getVaultBalance();

      expect(balanceAfter).to.equal(balanceBefore);
    });

    it("should revert cancel on non-existent cycle", async function () {
      const { proxy, operator } = await loadFixture(deployFixture);
      await expect(
        proxy.connect(operator).cancelCycle(CYCLE_ID),
      ).to.be.revertedWithCustomError(proxy, "CycleNotFound");
    });

    it("should revert cancel on already claimed cycle", async function () {
      const f = await loadFixture(activeCycleFixture);
      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );
      await f.proxy
        .connect(f.user1)
        .claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig);

      await expect(
        f.proxy.connect(f.operator).cancelCycle(CYCLE_ID),
      ).to.be.revertedWithCustomError(f.proxy, "CycleAlreadyClaimed");
    });

    it("should revert cancel on already cancelled cycle", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);
      await proxy.connect(operator).cancelCycle(CYCLE_ID);

      await expect(
        proxy.connect(operator).cancelCycle(CYCLE_ID),
      ).to.be.revertedWithCustomError(proxy, "CycleNotCancellable");
    });

    it("should revert cancel from non-operator", async function () {
      const { proxy, operator, user1, START_TIME, END_TIME } =
        await loadFixture(deployFixture);
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);

      await expect(
        proxy.connect(user1).cancelCycle(CYCLE_ID),
      ).to.be.revertedWithCustomError(proxy, "OnlyOperator");
    });
  });

  // ════════════════════════════════════════════════
  //  claimPrize
  // ════════════════════════════════════════════════

  describe("claimPrize", function () {
    it("should claim prize successfully", async function () {
      const f = await loadFixture(activeCycleFixture);
      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );

      await expect(
        f.proxy.connect(f.user1).claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig),
      )
        .to.emit(f.proxy, "PrizeClaimed")
        .withArgs(CYCLE_ID, f.user1.address, PRIZE_AMOUNT);
    });

    it("should transfer correct amount to winner", async function () {
      const f = await loadFixture(activeCycleFixture);
      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );

      const balanceBefore = await f.usdc.balanceOf(f.user1.address);
      await f.proxy
        .connect(f.user1)
        .claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig);
      const balanceAfter = await f.usdc.balanceOf(f.user1.address);

      expect(balanceAfter - balanceBefore).to.equal(PRIZE_AMOUNT);
    });

    it("should deduct from vault balance", async function () {
      const f = await loadFixture(activeCycleFixture);
      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );

      await f.proxy
        .connect(f.user1)
        .claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig);

      expect(await f.proxy.getVaultBalance()).to.equal(0);
    });

    it("should set cycle to Claimed and record winner", async function () {
      const f = await loadFixture(activeCycleFixture);
      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );

      await f.proxy
        .connect(f.user1)
        .claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig);

      const cycle = await f.proxy.getCycle(CYCLE_ID);
      expect(cycle.status).to.equal(CycleStatus.Claimed);
      expect(cycle.winner).to.equal(f.user1.address);
      expect(await f.proxy.isClaimed(CYCLE_ID)).to.be.true;
      expect(await f.proxy.getCycleWinner(CYCLE_ID)).to.equal(f.user1.address);
    });

    it("should clear currentCycleId after claim", async function () {
      const f = await loadFixture(activeCycleFixture);
      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );

      await f.proxy
        .connect(f.user1)
        .claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig);

      expect(await f.proxy.getCurrentCycleId()).to.equal(ethers.ZeroHash);
    });

    it("should increment user nonce", async function () {
      const f = await loadFixture(activeCycleFixture);
      const nonceBefore = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonceBefore,
      );

      await f.proxy
        .connect(f.user1)
        .claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonceBefore, sig);

      expect(await f.proxy.nonces(f.user1.address)).to.equal(nonceBefore + 1n);
    });

    it("should revert on non-existent cycle", async function () {
      const f = await loadFixture(activeCycleFixture);
      const fakeCycleId = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        fakeCycleId,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );

      await expect(
        f.proxy
          .connect(f.user1)
          .claimPrize(fakeCycleId, PRIZE_AMOUNT, nonce, sig),
      ).to.be.revertedWithCustomError(f.proxy, "CycleNotFound");
    });

    it("should revert before startTime", async function () {
      const { proxy, operator, user1, START_TIME, END_TIME } =
        await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);

      // Don't advance time — still before startTime
      const nonce = await proxy.nonces(user1.address);
      const sig = await signClaim(
        proxy,
        operator,
        CYCLE_ID,
        user1.address,
        PRIZE_AMOUNT,
        nonce,
      );

      await expect(
        proxy.connect(user1).claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig),
      ).to.be.revertedWithCustomError(proxy, "CycleNotClaimable");
    });

    it("should revert after endTime", async function () {
      const f = await loadFixture(activeCycleFixture);
      await time.increaseTo(f.END_TIME + 1);

      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );

      await expect(
        f.proxy.connect(f.user1).claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig),
      ).to.be.revertedWithCustomError(f.proxy, "CycleNotClaimable");
    });

    it("should revert double claim (second user tries same cycle)", async function () {
      const f = await loadFixture(activeCycleFixture);

      // First claim succeeds
      const nonce1 = await f.proxy.nonces(f.user1.address);
      const sig1 = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce1,
      );
      await f.proxy
        .connect(f.user1)
        .claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce1, sig1);

      // Second claim on same cycle should revert (cycle already Claimed)
      const nonce2 = await f.proxy.nonces(f.user2.address);
      const sig2 = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user2.address,
        PRIZE_AMOUNT,
        nonce2,
      );
      await expect(
        f.proxy
          .connect(f.user2)
          .claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce2, sig2),
      ).to.be.revertedWithCustomError(f.proxy, "CycleNotClaimable");
    });

    it("should revert with wrong amount", async function () {
      const f = await loadFixture(activeCycleFixture);
      const wrongAmount = PRIZE_AMOUNT + 1n;
      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        wrongAmount,
        nonce,
      );

      await expect(
        f.proxy.connect(f.user1).claimPrize(CYCLE_ID, wrongAmount, nonce, sig),
      ).to.be.revertedWithCustomError(f.proxy, "InvalidAmount");
    });

    it("should revert with invalid signature (wrong signer)", async function () {
      const f = await loadFixture(activeCycleFixture);
      const nonce = await f.proxy.nonces(f.user1.address);
      // Sign with attacker instead of operator
      const sig = await signClaim(
        f.proxy,
        f.attacker,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );

      await expect(
        f.proxy.connect(f.user1).claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig),
      ).to.be.revertedWithCustomError(f.proxy, "InvalidSignature");
    });

    it("should revert with wrong nonce", async function () {
      const f = await loadFixture(activeCycleFixture);
      const wrongNonce = 999n;
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        wrongNonce,
      );

      await expect(
        f.proxy
          .connect(f.user1)
          .claimPrize(CYCLE_ID, PRIZE_AMOUNT, wrongNonce, sig),
      ).to.be.revertedWithCustomError(f.proxy, "NonceMismatch");
    });

    it("should revert if vault balance insufficient", async function () {
      const { proxy, operator, user1, START_TIME, END_TIME } =
        await loadFixture(deployFixture);
      // Create cycle with 500 USDC prize but don't deposit anything
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);
      await time.increaseTo(START_TIME);

      const nonce = await proxy.nonces(user1.address);
      const sig = await signClaim(
        proxy,
        operator,
        CYCLE_ID,
        user1.address,
        PRIZE_AMOUNT,
        nonce,
      );

      await expect(
        proxy.connect(user1).claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig),
      ).to.be.revertedWithCustomError(proxy, "InsufficientVaultBalance");
    });

    it("should revert claim on cancelled cycle", async function () {
      const f = await loadFixture(activeCycleFixture);
      await f.proxy.connect(f.operator).cancelCycle(CYCLE_ID);

      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );

      await expect(
        f.proxy.connect(f.user1).claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig),
      ).to.be.revertedWithCustomError(f.proxy, "CycleNotClaimable");
    });

    it("should revert when paused", async function () {
      const f = await loadFixture(activeCycleFixture);
      await f.proxy.connect(f.owner).pause();

      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );

      await expect(
        f.proxy.connect(f.user1).claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig),
      ).to.be.revertedWithCustomError(f.proxy, "EnforcedPause");
    });
  });

  // ════════════════════════════════════════════════
  //  withdrawExcess
  // ════════════════════════════════════════════════

  describe("withdrawExcess", function () {
    it("should withdraw when no cycle is active", async function () {
      const { proxy, owner, operator } = await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);

      await expect(proxy.connect(owner).withdrawExcess(DEPOSIT_AMOUNT))
        .to.emit(proxy, "ExcessWithdrawn")
        .withArgs(DEPOSIT_AMOUNT, 0);

      expect(await proxy.getVaultBalance()).to.equal(0);
    });

    it("should withdraw partial amount", async function () {
      const { proxy, owner, operator } = await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      const half = DEPOSIT_AMOUNT / 2n;

      await proxy.connect(owner).withdrawExcess(half);
      expect(await proxy.getVaultBalance()).to.equal(half);
    });

    it("should revert from non-owner", async function () {
      const { proxy, operator } = await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);

      await expect(
        proxy.connect(operator).withdrawExcess(DEPOSIT_AMOUNT),
      ).to.be.revertedWithCustomError(proxy, "OwnableUnauthorizedAccount");
    });

    it("should revert with zero amount", async function () {
      const { proxy, owner, operator } = await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);

      await expect(
        proxy.connect(owner).withdrawExcess(0),
      ).to.be.revertedWithCustomError(proxy, "InvalidAmount");
    });

    it("should revert if amount exceeds vault balance", async function () {
      const { proxy, owner, operator } = await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);

      await expect(
        proxy.connect(owner).withdrawExcess(DEPOSIT_AMOUNT + 1n),
      ).to.be.revertedWithCustomError(proxy, "InsufficientVaultBalance");
    });

    it("should revert when a cycle is active (within time window)", async function () {
      const f = await loadFixture(activeCycleFixture);

      await expect(
        f.proxy.connect(f.owner).withdrawExcess(DEPOSIT_AMOUNT),
      ).to.be.revertedWithCustomError(f.proxy, "AnotherCycleActive");
    });

    it("should revert when a cycle is pending (before startTime)", async function () {
      const { proxy, owner, operator, START_TIME, END_TIME } =
        await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);

      // Still before startTime — cycle is pending
      await expect(
        proxy.connect(owner).withdrawExcess(DEPOSIT_AMOUNT),
      ).to.be.revertedWithCustomError(proxy, "AnotherCycleActive");
    });

    it("should allow withdraw after cycle ended naturally", async function () {
      const { proxy, owner, operator, START_TIME, END_TIME } =
        await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);

      // Advance past endTime
      await time.increaseTo(END_TIME + 1);

      await expect(proxy.connect(owner).withdrawExcess(DEPOSIT_AMOUNT)).to.emit(
        proxy,
        "ExcessWithdrawn",
      );
      expect(await proxy.getVaultBalance()).to.equal(0);
    });

    it("should allow withdraw after cycle was claimed", async function () {
      const f = await loadFixture(activeCycleFixture);
      // Deposit extra so vault has balance after claim
      await f.proxy.connect(f.operator).depositPrize(DEPOSIT_AMOUNT);

      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );
      await f.proxy
        .connect(f.user1)
        .claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig);

      // Should be able to withdraw the remaining
      await expect(
        f.proxy.connect(f.owner).withdrawExcess(DEPOSIT_AMOUNT),
      ).to.emit(f.proxy, "ExcessWithdrawn");
    });

    it("should allow withdraw after cycle was cancelled", async function () {
      const { proxy, owner, operator, START_TIME, END_TIME } =
        await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);
      await proxy.connect(operator).cancelCycle(CYCLE_ID);

      await expect(proxy.connect(owner).withdrawExcess(DEPOSIT_AMOUNT)).to.emit(
        proxy,
        "ExcessWithdrawn",
      );
    });

    it("should revert when paused", async function () {
      const { proxy, owner, operator } = await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      await proxy.connect(owner).pause();

      await expect(
        proxy.connect(owner).withdrawExcess(DEPOSIT_AMOUNT),
      ).to.be.revertedWithCustomError(proxy, "EnforcedPause");
    });
  });

  // ════════════════════════════════════════════════
  //  View Functions
  // ════════════════════════════════════════════════

  describe("View Functions", function () {
    it("getVaultBalance returns correct balance", async function () {
      const { proxy, operator } = await loadFixture(deployFixture);
      expect(await proxy.getVaultBalance()).to.equal(0);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      expect(await proxy.getVaultBalance()).to.equal(DEPOSIT_AMOUNT);
    });

    it("getCurrentCycleId returns zero when no cycle", async function () {
      const { proxy } = await loadFixture(deployFixture);
      expect(await proxy.getCurrentCycleId()).to.equal(ethers.ZeroHash);
    });

    it("getCurrentCycleId returns active cycle", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);
      expect(await proxy.getCurrentCycleId()).to.equal(CYCLE_ID);
    });

    it("isClaimed returns false for unclaimed cycle", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);
      expect(await proxy.isClaimed(CYCLE_ID)).to.be.false;
    });

    it("getCycleWinner returns zero address for unclaimed cycle", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);
      expect(await proxy.getCycleWinner(CYCLE_ID)).to.equal(ethers.ZeroAddress);
    });

    it("isCycleActive returns true during active window", async function () {
      const f = await loadFixture(activeCycleFixture);
      expect(await f.proxy.isCycleActive(CYCLE_ID)).to.be.true;
    });

    it("isCycleActive returns false before startTime", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);
      expect(await proxy.isCycleActive(CYCLE_ID)).to.be.false;
    });

    it("isCycleActive returns false after endTime", async function () {
      const f = await loadFixture(activeCycleFixture);
      await time.increaseTo(f.END_TIME + 1);
      expect(await f.proxy.isCycleActive(CYCLE_ID)).to.be.false;
    });

    it("isCycleActive returns false for claimed cycle", async function () {
      const f = await loadFixture(activeCycleFixture);
      const nonce = await f.proxy.nonces(f.user1.address);
      const sig = await signClaim(
        f.proxy,
        f.operator,
        CYCLE_ID,
        f.user1.address,
        PRIZE_AMOUNT,
        nonce,
      );
      await f.proxy
        .connect(f.user1)
        .claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig);
      expect(await f.proxy.isCycleActive(CYCLE_ID)).to.be.false;
    });

    it("isCycleActive returns false for cancelled cycle", async function () {
      const { proxy, operator, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);
      await proxy.connect(operator).cancelCycle(CYCLE_ID);
      expect(await proxy.isCycleActive(CYCLE_ID)).to.be.false;
    });

    it("domainSeparator returns non-zero value", async function () {
      const { proxy } = await loadFixture(deployFixture);
      expect(await proxy.domainSeparator()).to.not.equal(ethers.ZeroHash);
    });
  });

  // ════════════════════════════════════════════════
  //  UUPS Upgrade
  // ════════════════════════════════════════════════

  describe("UUPS Upgrade", function () {
    it("should allow owner to upgrade", async function () {
      const { proxy, owner } = await loadFixture(deployFixture);
      const Factory = await ethers.getContractFactory("PolareonVault", owner);
      await expect(
        upgrades.upgradeProxy(await proxy.getAddress(), Factory, {
          kind: "uups",
        }),
      ).to.not.be.reverted;
    });

    it("should revert upgrade from non-owner", async function () {
      const { proxy, operator } = await loadFixture(deployFixture);
      const Factory = await ethers.getContractFactory(
        "PolareonVault",
        operator,
      );
      await expect(
        upgrades.upgradeProxy(await proxy.getAddress(), Factory, {
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(proxy, "OwnableUnauthorizedAccount");
    });

    it("should preserve state after upgrade", async function () {
      const { proxy, owner, operator } = await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);

      const balanceBefore = await proxy.getVaultBalance();
      const operatorBefore = await proxy.operator();

      const Factory = await ethers.getContractFactory("PolareonVault", owner);
      await upgrades.upgradeProxy(await proxy.getAddress(), Factory, {
        kind: "uups",
      });

      expect(await proxy.getVaultBalance()).to.equal(balanceBefore);
      expect(await proxy.operator()).to.equal(operatorBefore);
    });
  });

  // ════════════════════════════════════════════════
  //  Carry-over Lifecycle (Integration)
  // ════════════════════════════════════════════════

  describe("Carry-over Lifecycle", function () {
    it("full carry-over: deposit → uncracked → deposit more → crack", async function () {
      const { proxy, operator, user1, usdc } = await loadFixture(deployFixture);

      // Week 1: deposit 500, create cycle, let it end uncracked
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      expect(await proxy.getVaultBalance()).to.equal(DEPOSIT_AMOUNT);

      const now1 = await time.latest();
      const start1 = now1 + 60;
      const end1 = start1 + 7 * 24 * 60 * 60;
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, DEPOSIT_AMOUNT, start1, end1);
      await time.increaseTo(end1 + 1);

      // Funds still there — carry-over!
      expect(await proxy.getVaultBalance()).to.equal(DEPOSIT_AMOUNT);

      // Week 2: deposit 500 more → total 1000
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      expect(await proxy.getVaultBalance()).to.equal(DEPOSIT_AMOUNT * 2n);

      const now2 = await time.latest();
      const start2 = now2 + 60;
      const end2 = start2 + 7 * 24 * 60 * 60;
      const bigPrize = DEPOSIT_AMOUNT * 2n;
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID_2, bigPrize, start2, end2);
      await time.increaseTo(end2 + 1);

      // Still uncracked — funds stay
      expect(await proxy.getVaultBalance()).to.equal(bigPrize);

      // Week 3: deposit 500 more → total 1500, CRACKED!
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      const totalPrize = DEPOSIT_AMOUNT * 3n;
      expect(await proxy.getVaultBalance()).to.equal(totalPrize);

      const now3 = await time.latest();
      const start3 = now3 + 60;
      const end3 = start3 + 7 * 24 * 60 * 60;
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID_3, totalPrize, start3, end3);
      await time.increaseTo(start3);

      // Winner claims!
      const nonce = await proxy.nonces(user1.address);
      const sig = await signClaim(
        proxy,
        operator,
        CYCLE_ID_3,
        user1.address,
        totalPrize,
        nonce,
      );

      const balanceBefore = await usdc.balanceOf(user1.address);
      await proxy.connect(user1).claimPrize(CYCLE_ID_3, totalPrize, nonce, sig);
      const balanceAfter = await usdc.balanceOf(user1.address);

      expect(balanceAfter - balanceBefore).to.equal(totalPrize);
      expect(await proxy.getVaultBalance()).to.equal(0);

      // Week 4: fresh start
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      expect(await proxy.getVaultBalance()).to.equal(DEPOSIT_AMOUNT);
    });

    it("vault balance invariant: always matches actual token balance", async function () {
      const { proxy, operator, user1, usdc } = await loadFixture(deployFixture);

      // Deposit
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);
      let vaultBal = await proxy.getVaultBalance();
      let actualBal = await usdc.balanceOf(await proxy.getAddress());
      expect(vaultBal).to.equal(actualBal);

      // Create cycle and claim
      const now = await time.latest();
      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, now + 60, now + 10000);
      await time.increaseTo(now + 60);

      const nonce = await proxy.nonces(user1.address);
      const sig = await signClaim(
        proxy,
        operator,
        CYCLE_ID,
        user1.address,
        PRIZE_AMOUNT,
        nonce,
      );
      await proxy.connect(user1).claimPrize(CYCLE_ID, PRIZE_AMOUNT, nonce, sig);

      vaultBal = await proxy.getVaultBalance();
      actualBal = await usdc.balanceOf(await proxy.getAddress());
      expect(vaultBal).to.equal(actualBal);
    });

    it("cancel does not affect vault balance", async function () {
      const { proxy, operator, usdc, START_TIME, END_TIME } = await loadFixture(
        deployFixture,
      );
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);

      await proxy
        .connect(operator)
        .createCycle(CYCLE_ID, PRIZE_AMOUNT, START_TIME, END_TIME);

      const vaultBefore = await proxy.getVaultBalance();
      const actualBefore = await usdc.balanceOf(await proxy.getAddress());

      await proxy.connect(operator).cancelCycle(CYCLE_ID);

      expect(await proxy.getVaultBalance()).to.equal(vaultBefore);
      expect(await usdc.balanceOf(await proxy.getAddress())).to.equal(
        actualBefore,
      );
    });

    it("withdraw decreases both vault balance and actual balance equally", async function () {
      const { proxy, owner, operator, usdc } = await loadFixture(deployFixture);
      await proxy.connect(operator).depositPrize(DEPOSIT_AMOUNT);

      const withdrawAmount = DEPOSIT_AMOUNT / 2n;
      await proxy.connect(owner).withdrawExcess(withdrawAmount);

      const vaultBal = await proxy.getVaultBalance();
      const actualBal = await usdc.balanceOf(await proxy.getAddress());
      expect(vaultBal).to.equal(actualBal);
      expect(vaultBal).to.equal(DEPOSIT_AMOUNT - withdrawAmount);
    });
  });
});
