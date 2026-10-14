# RentalBooking：閘道讀取介面

閘道（階段 B）用這些函式和事件判斷是否開門。規則的完整說明見 [SPEC.md](../SPEC.md) 第 6 節。

部署後，合約地址、鏈 ID 和示範房號會寫入 `deployed-booking.json`；ABI 在 `artifacts/contracts/RentalBooking.sol/RentalBooking.json`。

## 開門判斷

```solidity
function hasAccess(uint256 roomId, address wallet, uint256 time) external view returns (bool);
```

只有當這個房間存在一筆訂房，同時符合下列條件時，才回傳 `true`：

- `status == Booked`（未取消、未提早退房）
- `renter == wallet`（只認房客，不認付款人）
- `checkIn <= time < checkOut`

閘道在第 5 步驗證簽章後，必須以**當下時間**呼叫一次 `hasAccess`，而且不能快取結果，因為房客可能剛好取消訂房或退房。

`hasAccess` 只掃描「仍占用日期」的訂房清單（已取消或已結束的訂房會在下一次 `book()` 時被移除），所以**只適用於現在或未來的時間**；查詢過去的時間可能回傳 false。

`time` 用閘道的時間（Unix 秒）。區塊時間可能落後實際時間數秒，所以判斷「現在」時用閘道時間，不要用最新區塊的時間戳記。

## 查詢訂房

```solidity
function getBooking(uint256 bookingId) external view returns (Booking memory);
function getActiveBookingIds(uint256 roomId) external view returns (uint256[] memory);
function pendingWithdrawals(address account) external view returns (uint256);
```

`getActiveBookingIds` 只回傳仍占用日期的訂房；要查完整歷史，請用 `getBooking` 或過濾 `Booked` 事件。

`Booking` 的欄位：`payer`、`renter`、`roomId`、`checkIn`、`checkOut`、`amount`、`status`（0 = Booked、1 = Cancelled、2 = CheckedOut）、`rentReleased`。查詢不存在的 `bookingId` 會以 `UnknownBooking` revert。

## 事件

閘道可以監聽這些事件來更新快取或稽核紀錄，但**開門判斷一律以 `hasAccess` 為準**：

| 事件 | 時機 |
|---|---|
| `Booked(bookingId, roomId, renter, payer, checkIn, checkOut, amount)` | 訂房成功 |
| `Cancelled(bookingId, payer, refund)` | 付款人在入住前取消 |
| `CheckedOut(bookingId, renter)` | 房客提早退房，門禁立即失效 |
| `RentReleased(bookingId, amount)` | 入住時間到，房租記入房東帳上 |
| `Withdrawn(account, amount)` | 退款或房租被領走 |
| `RoomSet(roomId, pricePerNight, active)` | 房東設定房價或停用房間 |

`roomId`、`renter`、`bookingId` 都是 indexed，可以直接用來過濾事件。

## 成本

同一房間仍占用日期的訂房上限是 100 筆（`MAX_ACTIVE_BOOKINGS_PER_ROOM`）。已有 99 筆時，第 100 筆 `book()` 約用 907,000 gas；一次移除 100 筆已結束訂房的那筆 `book()` 約用 1,008,000 gas（測試輸出）。清單長度不會超過上限，所以單筆成本有上限。`hasAccess` 是 view 函式，閘道透過 RPC 呼叫不花 gas。
