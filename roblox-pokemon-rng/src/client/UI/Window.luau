--!nonstrict
--[[
	Window
	Shared chrome for the four full-screen panels (Bag, Index, Shop, Board).

	Only one window is open at a time. That is enforced here rather than by each
	panel, so adding a fifth panel doesn't mean touching the other four.
]]

local TweenService = game:GetService("TweenService")

local Create = require(script.Parent.Create)
local Theme = require(script.Parent.Theme)

local Window = {}
Window.__index = Window

local openWindow = nil

local OPEN_INFO = TweenInfo.new(0.18, Enum.EasingStyle.Back, Enum.EasingDirection.Out)
local CLOSE_INFO = TweenInfo.new(0.12, Enum.EasingStyle.Quad, Enum.EasingDirection.In)

function Window.new(parent: Instance, title: string, subtitle: string?)
	local self = setmetatable({}, Window)

	self.visible = false

	self.root = Create("Frame", {
		Name = title .. "Window",
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.5),
		Size = UDim2.fromScale(0.68, 0.74),
		BackgroundColor3 = Theme.color.panel,
		BorderSizePixel = 0,
		Visible = false,
		ZIndex = 20,
		Parent = parent,
	})
	Theme.corner(14).Parent = self.root
	Theme.stroke(Theme.color.stroke, 1.5).Parent = self.root

	-- Keep panels usable on phones, where 68% of a small screen is unreadable.
	Create("UISizeConstraint", {
		MinSize = Vector2.new(320, 260),
		MaxSize = Vector2.new(1100, 760),
		Parent = self.root,
	})

	local header = Create("Frame", {
		Name = "Header",
		Size = UDim2.new(1, 0, 0, 54),
		BackgroundColor3 = Theme.color.panelAlt,
		BorderSizePixel = 0,
		ZIndex = 21,
		Parent = self.root,
	})
	Theme.corner(14).Parent = header

	-- Square off the bottom of the rounded header so it meets the body cleanly.
	Create("Frame", {
		Position = UDim2.new(0, 0, 1, -14),
		Size = UDim2.new(1, 0, 0, 14),
		BackgroundColor3 = Theme.color.panelAlt,
		BorderSizePixel = 0,
		ZIndex = 21,
		Parent = header,
	})

	Theme.label({
		Text = title,
		Font = Theme.font.heading,
		TextSize = 20,
		Position = UDim2.fromOffset(18, 8),
		Size = UDim2.new(1, -80, 0, subtitle and 22 or 38),
		ZIndex = 22,
		Parent = header,
	})

	if subtitle then
		self.subtitleLabel = Theme.label({
			Text = subtitle,
			TextSize = 13,
			TextColor3 = Theme.color.subtext,
			Position = UDim2.fromOffset(18, 29),
			Size = UDim2.new(1, -80, 0, 18),
			ZIndex = 22,
			Parent = header,
		})
	end

	Theme.button({
		Text = "✕",
		TextSize = 18,
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -12, 0.5, 0),
		Size = UDim2.fromOffset(34, 34),
		BackgroundColor3 = Theme.color.panelHi,
		ZIndex = 22,
		Parent = header,
	}, function()
		self:close()
	end)

	self.content = Create("Frame", {
		Name = "Content",
		Position = UDim2.fromOffset(0, 54),
		Size = UDim2.new(1, 0, 1, -54),
		BackgroundTransparency = 1,
		ZIndex = 21,
		Parent = self.root,
	})

	return self
end

function Window:setSubtitle(text: string)
	if self.subtitleLabel then
		self.subtitleLabel.Text = text
	end
end

function Window:open()
	if openWindow and openWindow ~= self then
		openWindow:close()
	end
	openWindow = self

	self.visible = true
	self.root.Visible = true
	self.root.Size = UDim2.fromScale(0.6, 0.66)
	TweenService:Create(self.root, OPEN_INFO, { Size = UDim2.fromScale(0.68, 0.74) }):Play()

	if self.onOpen then
		self.onOpen()
	end
end

function Window:close()
	if not self.visible then
		return
	end
	self.visible = false
	if openWindow == self then
		openWindow = nil
	end

	local tween = TweenService:Create(self.root, CLOSE_INFO, { Size = UDim2.fromScale(0.6, 0.66) })
	tween.Completed:Connect(function()
		if not self.visible then
			self.root.Visible = false
		end
	end)
	tween:Play()
end

function Window:toggle()
	if self.visible then
		self:close()
	else
		self:open()
	end
end

function Window.closeAll()
	if openWindow then
		openWindow:close()
	end
end

--[[
	A scrolling body with a layout already attached, which is what every panel
	wants. Returns the scroller and its layout.
]]
function Window:scroller(layout: Instance)
	local scroller = Create("ScrollingFrame", {
		Size = UDim2.fromScale(1, 1),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		CanvasSize = UDim2.new(),
		ScrollBarThickness = 6,
		ScrollBarImageColor3 = Theme.color.stroke,
		ZIndex = 21,
		Parent = self.content,
	})
	Theme.padding(12).Parent = scroller
	layout.Parent = scroller
	Theme.autoCanvas(scroller, layout)
	return scroller
end

return Window
