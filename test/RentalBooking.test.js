// Stage A acceptance tests (SPEC.md v0.2, section 12).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ROOM = 101;
const PRICE = ethers.parseEther("0.01");
const NIGHT = 24 * 60 * 60;

async function deployFixture() {
  const [owner, payer, renter, other] = await ethers.getSigners();
  const booking = await ethers.deployContract("RentalBooking");
  await booking.setRoom(ROOM, PRICE, true);
  // First check-in is the start of the day after tomorrow, so it is always in the future.
  const now = await time.latest();
  const day0 = (Math.floor(now / NIGHT) + 2) * NIGHT;
  return { booking, owner, payer, renter, other, day0 };
}

// Books `nights` nights starting `startDay` days after day0, paid by `payer` for `renter`.
async function book(booking, payer, renter, day0, startDay, nights) {
  const checkIn = day0 + startDay * NIGHT;
  const checkOut = checkIn + nights * NIGHT;
  const tx = await booking.connect(payer).book(ROOM, checkIn, checkOut, renter.address, { value: PRICE * BigInt(nights) });
  const receipt = await tx.wait();
  const event = receipt.logs.map((l) => booking.interface.parseLog(l)).find((e) => e?.name === "Booked");
  return { id: event.args.bookingId, checkIn, checkOut, receipt };
}

describe("RentalBooking", function () {
  describe("book", function () {
    it("books with the exact payment and emits Booked", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const checkIn = day0;
      const checkOut = day0 + 2 * NIGHT;
      await expect(booking.connect(payer).book(ROOM, checkIn, checkOut, renter.address, { value: PRICE * 2n }))
        .to.emit(booking, "Booked")
        .withArgs(1, ROOM, renter.address, payer.address, checkIn, checkOut, PRICE * 2n);
    });

    it("rejects too little or too much payment", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const args = [ROOM, day0, day0 + 2 * NIGHT, renter.address];
      await expect(booking.connect(payer).book(...args, { value: PRICE }))
        .to.be.revertedWithCustomError(booking, "WrongPayment")
        .withArgs(PRICE * 2n, PRICE);
      await expect(booking.connect(payer).book(...args, { value: PRICE * 3n })).to.be.revertedWithCustomError(
        booking,
        "WrongPayment"
      );
    });

    it("rejects an inactive or unknown room", async function () {
      const { booking, owner, payer, renter, day0 } = await loadFixture(deployFixture);
      await booking.connect(owner).setRoom(ROOM, PRICE, false);
      await expect(
        booking.connect(payer).book(ROOM, day0, day0 + NIGHT, renter.address, { value: PRICE })
      ).to.be.revertedWithCustomError(booking, "RoomInactive");
      await expect(
        booking.connect(payer).book(999, day0, day0 + NIGHT, renter.address, { value: PRICE })
      ).to.be.revertedWithCustomError(booking, "RoomInactive");
    });

    it("rejects a zero renter address", async function () {
      const { booking, payer, day0 } = await loadFixture(deployFixture);
      await expect(
        booking.connect(payer).book(ROOM, day0, day0 + NIGHT, ethers.ZeroAddress, { value: PRICE })
      ).to.be.revertedWithCustomError(booking, "ZeroRenter");
    });

    it("rejects past check-in, partial nights and empty stays", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const now = await time.latest();
      const bad = [
        [now - NIGHT, now],
        [day0, day0 + NIGHT + 3600],
        [day0, day0],
      ];
      for (const [checkIn, checkOut] of bad) {
        await expect(
          booking.connect(payer).book(ROOM, checkIn, checkOut, renter.address, { value: PRICE })
        ).to.be.revertedWithCustomError(booking, "InvalidDates");
      }
    });

    it("only the owner can set rooms", async function () {
      const { booking, other } = await loadFixture(deployFixture);
      await expect(booking.connect(other).setRoom(ROOM, 1, true)).to.be.revertedWithCustomError(booking, "NotOwner");
    });
  });

  describe("payer and renter", function () {
    it("grants access only to the renter, and refunds the payer on cancellation", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const { id, checkIn } = await book(booking, payer, renter, day0, 0, 2);

      await expect(booking.connect(renter).cancel(id)).to.be.revertedWithCustomError(booking, "NotPayer");
      await expect(booking.connect(payer).cancel(id))
        .to.emit(booking, "Cancelled")
        .withArgs(id, payer.address, PRICE * 2n);
      expect(await booking.pendingWithdrawals(payer.address)).to.equal(PRICE * 2n);
      expect(await booking.pendingWithdrawals(renter.address)).to.equal(0);

      const second = await book(booking, payer, renter, day0, 0, 2);
      expect(await booking.hasAccess(ROOM, renter.address, second.checkIn)).to.equal(true);
      expect(await booking.hasAccess(ROOM, payer.address, checkIn)).to.equal(false);
    });
  });

  describe("occupancy", function () {
    it("rejects overlapping dates but allows back-to-back stays", async function () {
      const { booking, payer, renter, other, day0 } = await loadFixture(deployFixture);
      const first = await book(booking, payer, renter, day0, 0, 2); // nights 0-1
      await expect(
        booking.connect(other).book(ROOM, day0 + NIGHT, day0 + 3 * NIGHT, other.address, { value: PRICE * 2n })
      )
        .to.be.revertedWithCustomError(booking, "Overlap")
        .withArgs(first.id);
      await book(booking, other, other, day0, 2, 1); // starts exactly at first.checkOut
    });

    it("keeps the remaining dates occupied after an early checkout", async function () {
      const { booking, payer, renter, other, day0 } = await loadFixture(deployFixture);
      const { id, checkIn } = await book(booking, payer, renter, day0, 0, 3);
      await time.increaseTo(checkIn + 3600);
      await booking.connect(renter).checkOut(id);
      await expect(
        booking.connect(other).book(ROOM, day0 + NIGHT, day0 + 3 * NIGHT, other.address, { value: PRICE * 2n })
      ).to.be.revertedWithCustomError(booking, "Overlap");
    });

    it("frees the dates of a cancelled booking", async function () {
      const { booking, payer, renter, other, day0 } = await loadFixture(deployFixture);
      const { id } = await book(booking, payer, renter, day0, 0, 2);
      await booking.connect(payer).cancel(id);
      await book(booking, other, other, day0, 0, 2);
    });
  });

  describe("cancel", function () {
    it("allows only the payer, only before check-in", async function () {
      const { booking, payer, renter, other, day0 } = await loadFixture(deployFixture);
      const { id, checkIn } = await book(booking, payer, renter, day0, 0, 1);
      await expect(booking.connect(other).cancel(id)).to.be.revertedWithCustomError(booking, "NotPayer");
      await time.setNextBlockTimestamp(checkIn); // the exact check-in second
      await expect(booking.connect(payer).cancel(id)).to.be.revertedWithCustomError(booking, "TooLateToCancel");
    });

    it("still allows cancelling in the last second before check-in", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const { id, checkIn } = await book(booking, payer, renter, day0, 0, 1);
      await time.setNextBlockTimestamp(checkIn - 1);
      await expect(booking.connect(payer).cancel(id)).to.emit(booking, "Cancelled");
    });

    it("refunds only once and only to the payer", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const { id } = await book(booking, payer, renter, day0, 0, 2);
      await booking.connect(payer).cancel(id);
      await expect(booking.connect(payer).cancel(id)).to.be.revertedWithCustomError(booking, "NotBooked");
      expect(await booking.pendingWithdrawals(payer.address)).to.equal(PRICE * 2n);
      await expect(booking.connect(renter).withdraw()).to.be.revertedWithCustomError(booking, "NothingToWithdraw");
      await expect(booking.connect(payer).withdraw()).to.changeEtherBalances([payer, booking], [PRICE * 2n, -PRICE * 2n]);
    });
  });

  describe("checkOut", function () {
    it("lets the renter leave early and ends access immediately", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const { id, checkIn } = await book(booking, payer, renter, day0, 0, 2);
      await time.increaseTo(checkIn + 3600);
      expect(await booking.hasAccess(ROOM, renter.address, await time.latest())).to.equal(true);
      await expect(booking.connect(renter).checkOut(id)).to.emit(booking, "CheckedOut").withArgs(id, renter.address);
      expect(await booking.hasAccess(ROOM, renter.address, await time.latest())).to.equal(false);
    });

    it("does not let the owner end a stay", async function () {
      const { booking, owner, payer, renter, day0 } = await loadFixture(deployFixture);
      const { id, checkIn } = await book(booking, payer, renter, day0, 0, 2);
      await time.increaseTo(checkIn + 3600);
      await expect(booking.connect(owner).checkOut(id)).to.be.revertedWithCustomError(booking, "NotRenter");
      expect(await booking.hasAccess(ROOM, renter.address, await time.latest())).to.equal(true);
    });

    it("only works during the stay", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const { id, checkOut } = await book(booking, payer, renter, day0, 0, 1);
      await expect(booking.connect(renter).checkOut(id)).to.be.revertedWithCustomError(booking, "NotDuringStay");
      await time.setNextBlockTimestamp(checkOut); // the exact check-out second
      await expect(booking.connect(renter).checkOut(id)).to.be.revertedWithCustomError(booking, "NotDuringStay");
    });

    it("works at the first and the last second of the stay", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const first = await book(booking, payer, renter, day0, 0, 1);
      await time.setNextBlockTimestamp(first.checkIn);
      await expect(booking.connect(renter).checkOut(first.id)).to.emit(booking, "CheckedOut");

      const second = await book(booking, payer, renter, day0, 2, 1);
      await time.setNextBlockTimestamp(second.checkOut - 1);
      await expect(booking.connect(renter).checkOut(second.id)).to.emit(booking, "CheckedOut");
    });

    it("cannot check out twice, and early checkout refunds nothing", async function () {
      const { booking, owner, payer, renter, day0 } = await loadFixture(deployFixture);
      const { id, checkIn } = await book(booking, payer, renter, day0, 0, 3);
      await time.increaseTo(checkIn + 3600);
      await booking.connect(renter).checkOut(id);
      await expect(booking.connect(renter).checkOut(id)).to.be.revertedWithCustomError(booking, "NotBooked");
      await expect(booking.connect(payer).cancel(id)).to.be.revertedWithCustomError(booking, "NotBooked");
      expect(await booking.pendingWithdrawals(payer.address)).to.equal(0);
      // The full rent is still due to the owner (MVP policy, SPEC 6.4).
      await expect(booking.releaseRent(id)).to.emit(booking, "RentReleased").withArgs(id, PRICE * 3n);
      expect(await booking.pendingWithdrawals(owner.address)).to.equal(PRICE * 3n);
    });
  });

  describe("hasAccess", function () {
    it("follows the stay window and booking status", async function () {
      const { booking, payer, renter, other, day0 } = await loadFixture(deployFixture);
      const { checkIn, checkOut } = await book(booking, payer, renter, day0, 0, 2);
      expect(await booking.hasAccess(ROOM, renter.address, checkIn - 1)).to.equal(false);
      expect(await booking.hasAccess(ROOM, renter.address, checkIn)).to.equal(true);
      expect(await booking.hasAccess(ROOM, renter.address, checkOut - 1)).to.equal(true);
      expect(await booking.hasAccess(ROOM, renter.address, checkOut)).to.equal(false);
      expect(await booking.hasAccess(ROOM, other.address, checkIn)).to.equal(false);
      expect(await booking.hasAccess(ROOM + 1, renter.address, checkIn)).to.equal(false);
    });

    it("tracks two stays by the same renter, with a gap between them", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const a = await book(booking, payer, renter, day0, 0, 1);
      const b = await book(booking, payer, renter, day0, 2, 1);
      expect(await booking.hasAccess(ROOM, renter.address, a.checkIn)).to.equal(true);
      expect(await booking.hasAccess(ROOM, renter.address, a.checkOut)).to.equal(false); // the gap night
      expect(await booking.hasAccess(ROOM, renter.address, b.checkIn)).to.equal(true);
    });

    it("documented limit: past times read false once a finished stay is pruned", async function () {
      const { booking, payer, renter, other, day0 } = await loadFixture(deployFixture);
      const old = await book(booking, payer, renter, day0, 0, 1);
      expect(await booking.hasAccess(ROOM, renter.address, old.checkIn)).to.equal(true);
      await time.increaseTo(old.checkOut + 3600);
      await book(booking, other, other, day0, 3, 1); // prunes the finished stay
      // Same past time, now false: hasAccess is only valid for the current time (SPEC 6.5).
      expect(await booking.hasAccess(ROOM, renter.address, old.checkIn)).to.equal(false);
    });

    it("is false after cancellation", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const { id, checkIn } = await book(booking, payer, renter, day0, 0, 1);
      await booking.connect(payer).cancel(id);
      expect(await booking.hasAccess(ROOM, renter.address, checkIn)).to.equal(false);
    });
  });

  describe("releaseRent and withdraw", function () {
    it("releases rent to the owner only after check-in, once", async function () {
      const { booking, owner, payer, renter, other, day0 } = await loadFixture(deployFixture);
      const { id, checkIn } = await book(booking, payer, renter, day0, 0, 2);
      await time.setNextBlockTimestamp(checkIn - 1);
      await expect(booking.connect(other).releaseRent(id)).to.be.revertedWithCustomError(booking, "RentNotDue");
      await time.setNextBlockTimestamp(checkIn); // due from the exact check-in second
      await expect(booking.connect(other).releaseRent(id)).to.emit(booking, "RentReleased").withArgs(id, PRICE * 2n);
      await expect(booking.connect(other).releaseRent(id)).to.be.revertedWithCustomError(booking, "RentAlreadyReleased");
      expect(await booking.pendingWithdrawals(owner.address)).to.equal(PRICE * 2n);
    });

    it("cannot release rent for a cancelled booking", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const { id, checkIn } = await book(booking, payer, renter, day0, 0, 1);
      await booking.connect(payer).cancel(id);
      await time.increaseTo(checkIn);
      await expect(booking.releaseRent(id)).to.be.revertedWithCustomError(booking, "NotBooked");
    });

    it("pays out once; a second withdrawal fails", async function () {
      const { booking, owner, payer, renter, day0 } = await loadFixture(deployFixture);
      const cancelled = await book(booking, payer, renter, day0, 0, 1);
      await booking.connect(payer).cancel(cancelled.id);
      await expect(booking.connect(payer).withdraw()).to.changeEtherBalances([payer, booking], [PRICE, -PRICE]);
      await expect(booking.connect(payer).withdraw()).to.be.revertedWithCustomError(booking, "NothingToWithdraw");

      const stay = await book(booking, payer, renter, day0, 1, 1);
      await time.increaseTo(stay.checkIn);
      await booking.releaseRent(stay.id);
      await expect(booking.connect(owner).withdraw()).to.changeEtherBalances([owner, booking], [PRICE, -PRICE]);
      await expect(booking.connect(owner).withdraw()).to.be.revertedWithCustomError(booking, "NothingToWithdraw");
    });

    it("blocks a reentrancy attack on withdraw", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      await book(booking, payer, renter, day0, 5, 1); // other people's money held by the contract
      const attacker = await ethers.deployContract("ReentrantWithdrawer", [await booking.getAddress()]);
      const attackerAddress = await attacker.getAddress();
      await attacker.bookAndCancel(ROOM, day0, day0 + NIGHT, { value: PRICE });

      // The outer withdrawal succeeds and pays exactly one refund.
      await expect(attacker.attack()).to.changeEtherBalances([attacker, booking], [PRICE, -PRICE]);
      expect(await attacker.timesPaid()).to.equal(1);
      expect(await booking.pendingWithdrawals(attackerAddress)).to.equal(0);

      // The re-entry really happened and was stopped by OpenZeppelin's guard,
      // not by some other failure.
      expect(await attacker.reentryAttempts()).to.equal(1);
      const guardError = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);
      expect(await attacker.lastReentryError()).to.equal(guardError);

      // The other booking's funds are untouched.
      expect(await ethers.provider.getBalance(await booking.getAddress())).to.equal(PRICE);
    });
  });

  describe("limits", function () {
    async function fillRoom(booking, payer, renter, day0) {
      const max = Number(await booking.MAX_ACTIVE_BOOKINGS_PER_ROOM());
      const stays = [];
      for (let day = 0; day < max; day++) stays.push(await book(booking, payer, renter, day0, day, 1));
      return { max, stays };
    }

    it("caps active bookings per room and reports the worst-case gas", async function () {
      const { booking, payer, renter, day0 } = await loadFixture(deployFixture);
      const { max, stays } = await fillRoom(booking, payer, renter, day0);
      const last = stays[max - 1];
      console.log(`      gas for booking #${max} (scans ${max - 1} active): ${last.receipt.gasUsed}`);
      expect(last.receipt.gasUsed).to.be.lessThan(1_000_000n);

      await expect(
        booking.connect(payer).book(ROOM, day0 + max * NIGHT, day0 + (max + 1) * NIGHT, renter.address, { value: PRICE })
      ).to.be.revertedWithCustomError(booking, "RoomFull");
    });

    it("does not let finished stays fill the room", async function () {
      const { booking, payer, renter, other, day0 } = await loadFixture(deployFixture);
      const { max, stays } = await fillRoom(booking, payer, renter, day0);
      await time.increaseTo(stays[max - 1].checkOut + 3600); // every stay has ended

      const next = await book(booking, other, other, day0, max + 1, 1);
      console.log(`      gas for the booking that pruned ${max} finished stays: ${next.receipt.gasUsed}`);
      expect(next.receipt.gasUsed).to.be.lessThan(1_200_000n);
      expect(await booking.getActiveBookingIds(ROOM)).to.deep.equal([next.id]);
      // History is still readable.
      expect((await booking.getBooking(stays[0].id)).renter).to.equal(renter.address);
    });

    it("frees a slot when a booking is cancelled", async function () {
      const { booking, payer, renter, other, day0 } = await loadFixture(deployFixture);
      const { max, stays } = await fillRoom(booking, payer, renter, day0);
      await booking.connect(payer).cancel(stays[max - 1].id);
      await book(booking, other, other, day0, max - 1, 1); // the cancelled night is free again
    });

    it("keeps an early-checkout stay counted until its check-out time", async function () {
      const { booking, payer, renter, other, day0 } = await loadFixture(deployFixture);
      const { id, checkIn, checkOut } = await book(booking, payer, renter, day0, 0, 3);
      await time.increaseTo(checkIn + 3600);
      await booking.connect(renter).checkOut(id);
      await book(booking, other, other, day0, 5, 1); // prunes nothing: the stay still holds its dates
      expect(await booking.getActiveBookingIds(ROOM)).to.have.lengthOf(2);
      await time.increaseTo(checkOut);
      const later = await book(booking, other, other, day0, 7, 1);
      expect(await booking.getActiveBookingIds(ROOM)).to.not.include(id);
      expect(await booking.hasAccess(ROOM, other.address, later.checkIn)).to.equal(true);
    });
  });
});
