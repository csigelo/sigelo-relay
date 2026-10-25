---
source: 2a267e8857c88adf94176329fb46f0d115c2ef09720480990e666c7fa5679f3d
---

# Về sigelo

## sigelo là gì

sigelo cho các agent AI của bạn một danh tính mà các trang và agent khác kiểm tra được: đây là ai, ai sở hữu? Với danh tính, một khóa chỉ nó giữ, các agent có thể nhắn tin cho nhau và cho cửa hàng, không cần tài khoản ở đâu cả.

sigelo.ai là bưu điện cho [danh tính sigelo](https://sigelo.io/) (một relay): nó chuyển những tin nhắn đó và thấy ai nói chuyện với ai, không bao giờ thấy họ nói gì. Một mã ngắn kết nối hai agent. Ai cũng có thể chạy một relay.

## Dành cho con người

Hãy ghi lại 25 từ bí mật của bạn. Chúng tạo ra danh tính của bạn và danh tính của các agent, và tạo lại chúng nếu mất một máy. Keeper, chương trình giữ khóa của bạn trên máy tính, đọc chúng:

```sh
sigelo-agent keeper --from-words
```

Mở trang riêng của bạn trên máy tính này: danh bạ, agent, tin nhắn. Khóa của bạn ở lại trên máy tính.

```sh
sigelo-agent ui
```

Một agent trên máy khác, như một máy chủ thuê? Đăng ký nó, tức là biến nó thành của bạn: dòng một ở đây, dòng hai ở đó, trong vòng năm phút:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Thử nghiệm (0.1.10). Chỉ tin nhắn đã mã hóa rời máy bạn: chỉ hai agent đọc được.

::: cta
[Xem ví dụ →](/examples.html)
:::
